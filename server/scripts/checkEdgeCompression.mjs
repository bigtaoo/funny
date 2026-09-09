#!/usr/bin/env node
// Drift gate for edge JSON compression (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §8).
//
// `GET /world/map` at r=40 is 523,124 bytes of JSON and 29,708 on the wire once the reverse proxy
// compresses it — a 17.6x reduction that exists entirely in two configuration files and one response
// header. None of it is expressible in the type system, none of it has a unit test that could notice it
// disappearing, and production really does depend on it: `api.gamestao.com` measured `via: 1.1 Caddy`
// with no `cf-ray`, so there is no CDN layer quietly compressing behind Caddy's back.
//
// Three ways it can silently regress, all of which this fails on:
//
//  1. **`encode` leaves the Caddyfile.** Production stops compressing. Nothing else in the repo notices.
//  2. **`gzip_proxied` leaves client/nginx.conf while `gzip on` stays.** This is the nasty one: the
//     config still *reads* as "compression enabled", and nginx's default `gzip_proxied off` means it
//     compresses nothing that came from an upstream — which is every byte under /api, /world, /social
//     and /auction. A reviewer scanning for `gzip on` sees what they expect and moves on.
//  3. **A JSON writer goes back to node's chunked fallback.** A proxy cannot apply a minimum-size
//     threshold to a response whose size it does not know, so a chunked response gets compressed no
//     matter how small: a 31-byte `/world/active-season` reply measured 51 bytes on the wire before
//     `send()` started declaring `content-length`.
//
// Rule 3 is deliberately a flat "no `res.end(JSON.stringify(...))` anywhere under server/*/src", with no
// per-service allowlist, because the sweep that introduced this gate got the service list WRONG: it
// grepped each service for the word `fastify`, found it in auctionsvc and admin, and concluded both were
// covered — while both in fact also run their own hand-rolled node:http `send()`, on `/auction*` and
// `/ops/*`, straight through the compressing edge. An allowlist would have encoded that mistake. One rule
// with no exceptions cannot.
//
// Two restrictions carried over from checkAbsoluteWrites.mjs / checkAuctionJournal.mjs:
//
//  * Comments are stripped before rule 3 runs. Every rule here is documented in prose that quotes the
//    forbidden shape (this file included). A gate that fails on its own documentation gets deleted.
//  * The gate is mutation-tested against fixtures (worldsvc/test/check-edge-compression.test.ts): a
//    clean tree that must pass, plus one deliberate violation per rule that must fail, asserted by rule
//    id. A gate nobody has seen fail is not a gate.
//
// Usage: node scripts/checkEdgeCompression.mjs   (cwd = server/)
//        --root=<dir>   a different server/ tree (the mutation test's fixtures)
//        --nginx=<file> a different nginx.conf (defaults to <root>/../client/nginx.conf)

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ROOT = arg('root') ? resolve(arg('root')) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CADDYFILE = join(ROOT, 'Caddyfile');
const NGINX = arg('nginx') ? resolve(arg('nginx')) : resolve(ROOT, '..', 'client', 'nginx.conf');

const violations = [];
const fail = (rule, where, what, why) => violations.push({ rule, where, what, why });

/** Strip `//` line comments and `/* *\/` blocks, and `#` comments for the nginx/Caddy configs. */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function stripHashComments(src) {
  return src.replace(/^\s*#.*$/gm, '');
}

// ── rule caddy-encode ─────────────────────────────────────────────────────────
// Caddy's `encode` is the whole production fix. `encode` with no arguments is not accepted: it is legal
// Caddyfile syntax but enables no encoder, so it would read as compression while doing nothing.
if (!existsSync(CADDYFILE)) {
  fail('caddy-encode', relative(ROOT, CADDYFILE), 'file is missing', 'the production reverse-proxy config must exist for this gate to mean anything');
} else {
  const caddy = stripHashComments(readFileSync(CADDYFILE, 'utf8'));
  const encode = /^\s*encode\s+([^\n{]+)$/m.exec(caddy);
  if (!encode) {
    fail('caddy-encode', 'Caddyfile', 'no `encode` directive', 'without it every JSON face ships uncompressed — `GET /world/map` r=40 goes out at 523KB instead of 30KB');
  } else if (!/\bgzip\b/.test(encode[1])) {
    fail('caddy-encode', 'Caddyfile', `\`encode ${encode[1].trim()}\` does not list gzip`, 'gzip is the only encoding every client understands; zstd/br alone leaves older clients uncompressed');
  }
}

// ── rules nginx-gzip-proxied / nginx-gzip-json ────────────────────────────────
// client/nginx.conf is the local "real release" simulation. It is not production, but it is where every
// local byte measurement comes from, so it drifting means local numbers stop predicting production.
if (!existsSync(NGINX)) {
  fail('nginx-gzip-proxied', relative(ROOT, NGINX), 'file is missing', 'the local stack proxy config must exist for local byte measurements to be comparable to production');
} else {
  const nginx = stripHashComments(readFileSync(NGINX, 'utf8'));
  if (!/^\s*gzip\s+on\s*;/m.test(nginx)) {
    fail('nginx-gzip-proxied', 'client/nginx.conf', 'no `gzip on;`', 'local measurements would be taken against an uncompressed stack while production compresses');
  }
  const proxied = /^\s*gzip_proxied\s+([^;]+);/m.exec(nginx);
  if (!proxied) {
    fail('nginx-gzip-proxied', 'client/nginx.conf', 'no `gzip_proxied` directive', "nginx defaults it to `off`, i.e. it compresses NOTHING that came from an upstream — and /api /world /social /auction are all upstreams, so `gzip on` alone does nothing at all here");
  } else if (/^\s*off\s*$/.test(proxied[1])) {
    fail('nginx-gzip-proxied', 'client/nginx.conf', '`gzip_proxied off`', 'same effect as omitting it: proxied responses, which is all of the JSON, stay uncompressed');
  }
  const types = /^\s*gzip_types\s+([^;]+);/m.exec(nginx);
  if (!types) {
    fail('nginx-gzip-json', 'client/nginx.conf', 'no `gzip_types` directive', 'nginx only compresses text/html by default, so every JSON response is excluded');
  } else if (!/\bapplication\/json\b/.test(types[1])) {
    fail('nginx-gzip-json', 'client/nginx.conf', '`gzip_types` does not list application/json', 'the map payload this gate exists for is application/json');
  }
}

// ── rule declared-length ──────────────────────────────────────────────────────
// Every hand-rolled node:http JSON writer must declare its length. `res.end(JSON.stringify(...))` is the
// exact shape that falls back to chunked framing; the fixed shape buffers first and writes content-length.
const FORBIDDEN = /res\.end\(\s*JSON\.stringify\(/;
function scanTs(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { scanTs(p, out); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const workspaces = readdirSync(ROOT).filter((n) => {
  try { return statSync(join(ROOT, n, 'src')).isDirectory(); } catch { return false; }
});
let scanned = 0;
for (const ws of workspaces) {
  for (const file of scanTs(join(ROOT, ws, 'src'), [])) {
    // generated/** is codegen output; it does not write HTTP responses.
    if (file.includes(`${join('src', 'generated')}`)) continue;
    scanned++;
    const src = stripJsComments(readFileSync(file, 'utf8'));
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!FORBIDDEN.test(lines[i])) continue;
      fail('declared-length', `${relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`, lines[i].trim(),
        'buffer the body first and declare `content-length`, or the proxy cannot honour its minimum-size threshold and compresses tiny replies into LARGER ones');
    }
  }
}

if (violations.length === 0) {
  console.log(`checkEdgeCompression(): Caddyfile encode ok, nginx gzip ok, ${scanned} server source files carry no chunked JSON writer.`);
  process.exit(0);
}

console.error('FAILED — edge JSON compression has drifted (see design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md §8):');
for (const v of violations) {
  console.error(`  • [${v.rule}] ${v.where}  ${v.what}`);
  console.error(`      ${v.why}`);
}
process.exit(1);
