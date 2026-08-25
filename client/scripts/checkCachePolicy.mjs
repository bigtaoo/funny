#!/usr/bin/env node
// Cache-policy gate for the web build (ASSET_PACKAGING §13.1, deploy-cloudflare.md).
//
// The failure this exists to prevent already happened once, and went unnoticed for over a year:
// deploy-cloudflare.md's table said contenthashed files are served `immutable`, client/nginx.conf
// implemented it, and the file that production ACTUALLY reads — the `_headers` emitted next to the
// bundle — only ever had index.html and version.json. Two of the three places anyone would look
// gave the right impression; only `curl` against the live domain disagreed. Every repeat session
// paid a conditional request per asset, with the 2 MB bundle's revalidation ahead of parse.
//
// So this checks the emitted artifact, not the intent. It runs after `npm run build:web` (CI wires
// it next to check:bundlesize) and reads only `dist/`.
//
// Usage: node scripts/checkCachePolicy.mjs [--dist=<path>]   (default: ./dist)
// `--dist` exists so test/cachePolicyGate.test.ts can point it at fixture trees and confirm the
// gate actually FAILS when the contract is broken — a gate nobody has seen fail is not a gate
// (claudedocs: "gate 脚本自己要做变异测试").
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const distArg = process.argv.find((a) => a.startsWith('--dist='));
const DIST = resolve(process.cwd(), distArg ? distArg.slice('--dist='.length) : 'dist');

/** Where every contenthashed file must live, so its cache rule can be stated without overlap. */
const HASHED_DIR = 'static';
/** A year, the conventional "forever" for an immutable URL. */
const MIN_IMMUTABLE_MAX_AGE = 31_536_000;

const problems = [];
const fail = (msg) => problems.push(msg);

if (!existsSync(DIST)) {
  console.error(`\n❌ ${relative(process.cwd(), DIST)} not found — run \`npm run build:web\` first.\n`);
  process.exit(1);
}

// ── parse _headers ────────────────────────────────────────────────────────────
// Cloudflare's format: a line starting at column 0 is a URL pattern; indented lines below it are
// `Header: value` for that pattern.
function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { rules.push({ pattern: raw.trim(), headers: {} }); continue; }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(raw);
    if (m && rules.length) rules[rules.length - 1].headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return rules;
}

/**
 * Cloudflare splat matching: `*` greedily matches any characters, including `/`. Only one splat is
 * allowed per pattern, which this deliberately does NOT emulate loosely — a pattern with two would
 * behave differently in production than here, so it is reported rather than guessed at.
 */
function matches(pattern, urlPath) {
  const splats = (pattern.match(/\*/g) ?? []).length;
  if (splats > 1) { fail(`_headers pattern "${pattern}" has ${splats} splats; Cloudflare allows one.`); return false; }
  if (splats === 0) return pattern === urlPath;
  const [head, tail] = pattern.split('*');
  return urlPath.startsWith(head) && urlPath.endsWith(tail) && urlPath.length >= head.length + tail.length;
}

const headersPath = join(DIST, '_headers');
if (!existsSync(headersPath)) fail('dist/_headers is missing — nothing sets any cache policy in production.');
const rules = existsSync(headersPath) ? parseHeaders(readFileSync(headersPath, 'utf8')) : [];

// ── collect emitted files as URL paths ────────────────────────────────────────
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (statSync(p).size >= 0) out.push('/' + relative(DIST, p).replace(/\\/g, '/'));
  }
  return out;
}
const files = collect(DIST).filter((f) => f !== '/_headers');

const isImmutable = (h) => {
  const cc = h['cache-control'] ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? -1);
  return cc.includes('immutable') && maxAge >= MIN_IMMUTABLE_MAX_AGE;
};
const revalidates = (h) => /no-cache|max-age=0/.test(h['cache-control'] ?? '');

// ── 1. every contenthashed file is served immutable, by exactly one rule ──────
const hashed = files.filter((f) => f.startsWith(`/${HASHED_DIR}/`));
if (hashed.length === 0) {
  fail(`no files under /${HASHED_DIR}/ — contenthashed output must live there so its cache rule cannot overlap the fixed-name files (see webpack.config.js output.filename / assetModuleFilename).`);
}
for (const f of hashed) {
  const hit = rules.filter((r) => matches(r.pattern, f) && r.headers['cache-control']);
  if (hit.length === 0) fail(`${f} is contenthashed but no _headers rule sets its Cache-Control (it will fall back to Cloudflare's revalidate-every-time default).`);
  else if (!hit.every((r) => isImmutable(r.headers))) fail(`${f} is contenthashed but "${hit.map((r) => r.pattern).join(', ')}" does not serve it immutable with max-age>=${MIN_IMMUTABLE_MAX_AGE}.`);
}

// ── 2. the fixed-name entry points still revalidate ───────────────────────────
for (const f of ['/index.html', '/version.json']) {
  if (!files.includes(f)) continue; // version.json is production-only
  const hit = rules.filter((r) => matches(r.pattern, f) && r.headers['cache-control']);
  if (hit.length === 0) fail(`${f} has no Cache-Control rule; it must revalidate or players keep booting an old build.`);
  if (hit.some((r) => isImmutable(r.headers))) fail(`${f} is served immutable — a stale index.html pins every player to a dead bundle URL.`);
  if (hit.length && !hit.every((r) => revalidates(r.headers))) fail(`${f} must be no-cache/must-revalidate, got "${hit.map((r) => r.headers['cache-control']).join(' | ')}".`);
}

// ── 3. no file may match two Cache-Control rules ──────────────────────────────
// THE invariant. Cloudflare has no precedence model: a request matching several rules inherits all
// of their headers, and a header set twice is COMMA-JOINED rather than overridden. So a broad `/*`
// plus a narrow `/index.html` does not override — it emits one self-contradicting
// `Cache-Control: ...immutable, no-cache, must-revalidate`. Non-overlapping patterns are the only
// well-defined way to express this policy, which is why `static/` exists.
for (const f of files) {
  const hit = rules.filter((r) => matches(r.pattern, f) && r.headers['cache-control']);
  if (hit.length > 1) fail(`${f} matches ${hit.length} Cache-Control rules (${hit.map((r) => r.pattern).join(', ')}). Cloudflare COMMA-JOINS them rather than letting the narrower one win — make the patterns non-overlapping.`);
}

// ── 4. the entry bundle really is under the hashed dir ───────────────────────
const html = files.includes('/index.html') ? readFileSync(join(DIST, 'index.html'), 'utf8') : '';
const entry = /<script[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
if (entry && !entry.replace(/^\//, '').startsWith(`${HASHED_DIR}/`)) {
  fail(`the entry bundle is served from "${entry}", outside /${HASHED_DIR}/ — it is contenthashed, so it belongs where the immutable rule applies.`);
}

if (problems.length) {
  console.error(`\n❌ cache policy (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nSee ASSET_PACKAGING §13.1 — and verify the fix against the live origin with');
  console.error('`curl -sSI https://a.gamestao.com/<file>`, not against this repo.\n');
  process.exit(1);
}

console.log(`✅ cache policy: ${hashed.length} contenthashed files immutable, entry points revalidated, no overlapping rules.`);
