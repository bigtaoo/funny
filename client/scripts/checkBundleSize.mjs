#!/usr/bin/env node
// Shipped-size budget gate for the web build (ASSET_PACKAGING §13).
//
// Why this exists: the bundle grew from the ~1.5 MB recorded in ASSET_PACKAGING §1 to 2.08 MB
// without anything noticing, and the L0 boot gate — the one tier the player literally waits on —
// has no enforcement behind its "keep it MINIMAL" discipline beyond a code comment. The 500-line
// convention has `checkFileLength.mjs`; this is the same idea for bytes.
//
// Deliberately ABSOLUTE budgets with headroom, NOT the ratchet-on-any-growth semantics of
// checkFileLength.mjs. Line counts move when someone adds lines; byte counts move on every
// dependency bump, minifier version and art re-export, so a no-growth ratchet would be red on
// commits that did nothing wrong and would train everyone to bump the baseline reflexively. A
// budget with stated headroom fails only when a change actually eats the headroom, and the failure
// message is then worth reading.
//
// Measures the REAL build output rather than re-deriving what should be in it: the entry script and
// the L0 gate tier are both read back out of the emitted `dist/index.html` (the gate tier is exactly
// the `fetchpriority=high` preloads that build/preloadBootAssets.js wrote there, which
// test/bootPreloadManifest.test.ts already pins to assets/bootManifest.ts's blocking tier). So this
// cannot drift from the manifest, and it counts post-minification, post-contenthash bytes.
//
// Usage: node scripts/checkBundleSize.mjs   (run with cwd = client/, after `npm run build:web`).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const DIST = resolve(process.cwd(), 'dist');
const BUDGET_PATH = resolve(process.cwd(), 'scripts', 'bundle-size-budget.json');
const KIB = 1024;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(join(DIST, 'index.html'), 'utf8');
} catch {
  fail('dist/index.html not found — run `npm run build:web` first (this gate measures real build output).');
}

/** The entry bundle: the one <script src> html-webpack-plugin injected. */
function entryScriptName() {
  const m = /<script[^>]*\ssrc="([^"]+)"/.exec(html);
  if (!m) fail('no <script src> in dist/index.html — did the build actually emit an entry chunk?');
  return m[1].replace(/^\//, '');
}

/** The L0 blocking tier: every preload the plugin marked fetchpriority="high". */
function gateAssetNames() {
  const names = [];
  for (const tag of html.match(/<link[^>]*>/g) ?? []) {
    if (!/rel="preload"/.test(tag) || !/fetchpriority="high"/.test(tag)) continue;
    const href = /\shref="([^"]+)"/.exec(tag);
    if (href) names.push(href[1].replace(/^\//, ''));
  }
  if (names.length === 0) fail('no fetchpriority="high" preloads in dist/index.html — PreloadBootAssetsPlugin did not run?');
  return names;
}

function sizeOf(name) {
  try {
    return statSync(join(DIST, name)).size;
  } catch {
    fail(`dist/${name} is referenced by index.html but missing from the build output.`);
  }
}

function distTotalBytes(dir = DIST) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? distTotalBytes(p) : statSync(p).size;
  }
  return total;
}

const entry = entryScriptName();
const gateAssets = gateAssetNames();

// Brotli, because nobody downloads the raw file — but q11 is a STABLE RELATIVE METRIC, not a
// prediction of the wire size. Cloudflare compresses on the fly at a much lower quality: the same
// bundle measures 470.9 KiB at q11 here and is served as 600393 bytes from a.gamestao.com. Budget
// against this number, compare like with like, and do not read it as "what the player downloads".
const entryBrotli = brotliCompressSync(readFileSync(join(DIST, entry)), {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY },
}).length;

const measured = {
  'entry.brotli': {
    bytes: entryBrotli,
    what: `${entry} (brotli q11) — the whole app's code, downloaded before anything can run`,
  },
  'boot.gate': {
    bytes: gateAssets.reduce((sum, n) => sum + sizeOf(n), 0),
    what: `${gateAssets.length} L0 blocking-tier assets — the bytes the loading screen waits on`,
  },
  'dist.total': {
    bytes: distTotalBytes(),
    what: 'every emitted file — the whole-package figure the WeChat/mobile targets inherit',
  },
};

const budgets = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
const kib = (n) => `${(n / KIB).toFixed(1)} KiB`;

let failed = false;
console.log('Shipped-size budgets (client web build):\n');
for (const [key, { bytes, what }] of Object.entries(measured)) {
  const budget = budgets[key];
  if (!budget) {
    console.error(`  ✖ ${key}: no budget entry in scripts/bundle-size-budget.json`);
    failed = true;
    continue;
  }
  const pct = ((bytes / budget.maxBytes) * 100).toFixed(1);
  const over = bytes > budget.maxBytes;
  failed ||= over;
  console.log(`  ${over ? '✖' : '✓'} ${key.padEnd(13)} ${kib(bytes).padStart(11)} / ${kib(budget.maxBytes).padStart(11)}  (${pct}%)`);
  console.log(`      ${what}`);
  if (over) {
    console.log(`      OVER BUDGET by ${kib(bytes - budget.maxBytes)}. Budget rationale: ${budget.reason}`);
    console.log('      Cut bytes, or raise the budget in scripts/bundle-size-budget.json *with a written reason* —');
    console.log('      the number is a decision, not a high-water mark to be bumped on sight.');
  }
}

if (failed) fail('shipped-size budget exceeded (see above).');
console.log('\n✅ all shipped-size budgets met.');
