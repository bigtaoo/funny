#!/usr/bin/env node
// WeChat mini-game package-completeness gate (ASSET_PACKAGING §4).
//
// `client/wechatgame/` is the one shipped directory that is entirely gitignored, so nothing
// guarantees its two halves came from the same build — and they are only meaningful together:
// `pixigame.js` bakes every asset URL in at build time (`cdn/<contenthash><ext>`), and the bytes
// those URLs name sit next to it in `cdn/`.
//
// This has already cost a session (2026-09-01). A previous closeout refreshed `pixigame.js` (+ its
// map) into the main checkout without re-running `build:wechat` there, so the bundle was current
// while `cdn/` still held the 57 files a July build had emitted — against 301 references. Every
// boot asset resolved to a file that was not on disk, so WeChat DevTools showed a black screen with
// no error attributable to it: the L0 gate simply never completed.
//
// What it checks (all against the emitted artifact, never against intent):
//   1. the shell is intact       — game.js requires ./pixigame.js, game.json parses
//   2. every baked asset URL has its file on disk   ← the black screen above
//   3. the bundle is one file    — a `<id>.pixigame.js` sibling means asyncChunks:false was lost
//                                  (ASSET_PACKAGING §4.0; test/wechatSingleBundle.test.ts guards
//                                  the config, this guards the output)
//   4. every asset the bundle asks the PACKAGE for is actually packed   ← the 2026-09-01 (evening)
//                                  "boots, then nothing" failure: the bundle asked the package for
//                                  `cdn/<hash>`, and packOptions.ignore had excluded `cdn/` from the
//                                  package. Rule 2 says the byte is on disk; this says it is
//                                  reachable. See ASSET_PACKAGING_LOG.md §21.
//
// ⚠ What it deliberately cannot check: the mirror image of the failure above — a STALE bundle
// against a fresh `cdn/`. The wechat output runs with `clean:false` (game.js/game.json/cdn live
// there and must survive), so unreferenced files from earlier builds accumulate rather than being
// swept; an old bundle's hashes are therefore still present and pass rule 2. Orphans are reported
// as a count for exactly that reason: normal after any rebuild, worth a glance when it is large.
//
// Usage: node scripts/checkWechatPackage.mjs [--pkg=<path>]   (default: ./wechatgame)
// `--pkg` exists so test/wechatPackageGate.test.ts can point it at fixture trees and confirm the
// gate actually FAILS when the contract is broken — a gate nobody has seen fail is not a gate.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ignoredBy, unsupportedEntries, describeEntry } from './lib/packIgnore.mjs';

const pkgArg = process.argv.find((a) => a.startsWith('--pkg='));
const PKG = resolve(process.cwd(), pkgArg ? pkgArg.slice('--pkg='.length) : 'wechatgame');
const BUNDLE = 'pixigame.js';
const ASSET_DIR = 'cdn';
/** How many missing files to name before collapsing the rest into a count. */
const MAX_LISTED = 12;

const problems = [];
const fail = (msg) => problems.push(msg);

if (!existsSync(join(PKG, BUNDLE))) {
  console.error(`\n❌ ${relative(process.cwd(), join(PKG, BUNDLE))} not found — run \`npm run build:wechat\` first.\n`);
  process.exit(1);
}

const bundle = readFileSync(join(PKG, BUNDLE), 'utf8');

// ── 1. the shell ──────────────────────────────────────────────────────────────
// game.js is the runtime's entry point; it exists only to require the bundle. game.json carries
// the orientation/lockstep config. Both are hand-written and gitignored along with everything
// else here, so a wiped-and-rebuilt wechatgame/ can lose them without webpack noticing.
if (!existsSync(join(PKG, 'game.js'))) {
  fail('game.js is missing — the mini-game runtime has no entry point (it should `require(\'./pixigame.js\')`).');
} else if (!/require\(\s*['"]\.\/pixigame\.js['"]\s*\)/.test(readFileSync(join(PKG, 'game.js'), 'utf8'))) {
  fail("game.js does not require('./pixigame.js') — the runtime would start and load nothing.");
}
if (!existsSync(join(PKG, 'game.json'))) {
  fail('game.json is missing — deviceOrientation and the lockstep options ship in it.');
} else {
  try { JSON.parse(readFileSync(join(PKG, 'game.json'), 'utf8')); }
  catch (e) { fail(`game.json is not valid JSON (${e.message}) — the runtime refuses to launch.`); }
}

// ── 2. every baked asset URL resolves to a file ───────────────────────────────
// Two url shapes reach the bundle, from the same webpack generator (webpack.config.js, isWechat):
//   - `cdn/<hash><ext>`                  — publicPath '' (no NW_ASSET_CDN): read from the package
//   - `https://<host>/cdn/<hash><ext>`   — plan A: downloaded at runtime by WechatAssetIO
// Both are checked against the local dir. For plan A that is not where the runtime will read from,
// but it IS the upload set: a file missing here would be missing on the CDN too.
// The lookbehind keeps a `mycdn/<hash>` substring from counting, while still matching the absolute
// form — where the character before the directory is the url's own `/`.
const refPattern = new RegExp(`(?<![\\w])${ASSET_DIR}/([0-9a-f]{8,64}\\.[a-z0-9]{2,5})`, 'gi');
const referenced = new Set();
// Which of the two shapes each hit is — the input to rule 4. Only the absolute form can be
// preceded by `/` (it is the url's own separator, as in `https://host/cdn/<hash>`); the relative
// form is baked as a bare string literal, so what precedes it is the quote.
let relativeRefs = 0;
let absoluteRefs = 0;
for (const m of bundle.matchAll(refPattern)) {
  referenced.add(m[1]);
  if (bundle[m.index - 1] === '/') absoluteRefs++; else relativeRefs++;
}

const present = existsSync(join(PKG, ASSET_DIR))
  ? new Set(readdirSync(join(PKG, ASSET_DIR)))
  : new Set();

const missing = [...referenced].filter((name) => !present.has(name)).sort();
if (missing.length) {
  const shown = missing.slice(0, MAX_LISTED);
  const rest = missing.length - shown.length;
  fail(
    `${missing.length} of ${referenced.size} baked asset URLs have no file in ${ASSET_DIR}/:\n` +
    shown.map((n) => `      - ${ASSET_DIR}/${n}`).join('\n') +
    (rest > 0 ? `\n      … and ${rest} more` : '') +
    `\n    ${BUNDLE} and ${ASSET_DIR}/ came from different builds. Re-run \`npm run build:wechat\`` +
    ' **in this checkout** — copying the bundle out of a worktree leaves the assets behind.'
  );
}

// ── 3. one bundle, not a chunk graph ─────────────────────────────────────────
// `output.asyncChunks: false` inlines every dynamic import; a sibling chunk means it was lost or
// bypassed. game.js requires only pixigame.js and packOptions never packs the sibling, and the
// JSONP loader a split drags in (document.createElement('script') / importScripts) exists in no
// part of this runtime — so the first chunk request throws instead of degrading.
const strays = readdirSync(PKG).filter((f) => f !== BUNDLE && /\.pixigame\.js$/.test(f));
if (strays.length) {
  fail(`${strays.length} stray chunk file(s) next to the bundle (${strays.join(', ')}) — a dynamic import escaped output.asyncChunks:false. See ASSET_PACKAGING §4.0.`);
}

// ── 4. packOptions.ignore agrees with the url shape ──────────────────────────
// Rules 1-3 all ask "is the byte on disk". This one asks the question after that: **is it in the
// package**. `packOptions.ignore` is DevTools' pack manifest, and it governs the simulator too, not
// just upload — DevTools says so itself when a build trips this ("configured to ignore when package
// uploads, so simulator cannot get those").
//
// The two url shapes webpack can bake (see rule 2) need OPPOSITE answers, and nothing tied the two
// files together until this rule existed:
//   - relative `cdn/<hash>`  (NW_ASSET_CDN unset, whole-package mode) → cdn/ MUST be packed;
//     excluded, WechatAssetIO's in-package `readFileSync` fails on every single asset. That was the
//     live state on 2026-09-01: `ignore` had carried `{folder: cdn}` since plan A landed, so the
//     mode ASSET_PACKAGING §4.0 calls "整包跑，仅本地 IDE 自测用" had in fact never once run.
//   - absolute `https://…/cdn/<hash>` (plan A) → cdn/ MUST be excluded; packed, ~21 MB of art goes
//     into a main package with a 4 MB ceiling, and the runtime downloads it a second time anyway.
const packCfg = { ignore: [], from: null };
for (const name of ['project.config.json', 'project.private.config.json']) { // private overrides
  if (!existsSync(join(PKG, name))) continue;
  try {
    const parsed = JSON.parse(readFileSync(join(PKG, name), 'utf8'));
    if (Array.isArray(parsed?.packOptions?.ignore)) { packCfg.ignore = parsed.packOptions.ignore; packCfg.from = name; }
  } catch (e) {
    fail(`${name} is not valid JSON (${e.message}) — DevTools cannot read the pack manifest out of it.`);
  }
}
// Asked PER REFERENCED FILE, not by pattern-spotting: the first version of this rule looked for the
// `cdn` folder entry specifically — the one spelling that had shipped — and `{"type":"suffix",
// "value":".png"}` would have walked straight past it. scripts/lib/packIgnore.mjs implements the
// six documented `type`s, and refuses to guess about anything else.
const where = packCfg.from ? `${packCfg.from} packOptions.ignore` : 'packOptions.ignore';
const unevaluable = unsupportedEntries(packCfg.ignore);
if (unevaluable.length) {
  fail(
    `${where} contains ${unevaluable.length} entr${unevaluable.length > 1 ? 'ies' : 'y'} this gate cannot ` +
    `evaluate, so it cannot say whether the assets are packed:\n` +
    unevaluable.map(({ entry, why }) => `      - ${describeEntry(entry)} — ${why}`).join('\n') +
    '\n    Extend scripts/lib/packIgnore.mjs rather than leaving the rule silently inert.'
  );
}

const excluded = [...referenced]
  .map((name) => ({ name, by: ignoredBy(`${ASSET_DIR}/${name}`, packCfg.ignore) }))
  .filter((r) => r.by);
if (relativeRefs > 0 && excluded.length) {
  const shown = excluded.slice(0, MAX_LISTED);
  const rest = excluded.length - shown.length;
  const culprits = [...new Set(excluded.map((r) => describeEntry(r.by)))];
  fail(
    `${where} excludes ${excluded.length} of the ${referenced.size} asset(s) the bundle asks the ` +
    `package for — via ${culprits.join(', ')}:\n` +
    shown.map((r) => `      - ${ASSET_DIR}/${r.name}`).join('\n') +
    (rest > 0 ? `\n      … and ${rest} more` : '') +
    `\n    The bundle bakes ${relativeRefs} package-relative ${ASSET_DIR}/ reference(s), so those reads` +
    ' go through WechatAssetIO\'s in-package branch: every one fails with `readFileSync:fail permission' +
    ' denied` and the game boots to an empty screen. Either drop that entry (whole-package mode, local' +
    ' IDE self-test) or rebuild with NW_ASSET_CDN set (plan A). See ASSET_PACKAGING §4.0.'
  );
} else if (relativeRefs === 0 && absoluteRefs > 0 && excluded.length < referenced.size) {
  fail(
    `the bundle bakes absolute CDN urls (plan A), but ${where} leaves ` +
    `${referenced.size - excluded.length} of ${referenced.size} asset(s) in the package — ` +
    'the asset set would be packed into the main package (4 MB ceiling) and then downloaded again at ' +
    'runtime. Add `{ "type": "folder", "value": "cdn" }`. See ASSET_PACKAGING §4.0.'
  );
}

if (problems.length) {
  console.error(`\n❌ wechat package (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nSee ASSET_PACKAGING §4. If DevTools shows a black screen, this gate runs offline —');
  console.error('`npm run check:wechatpackage` — and answers "is the package even complete" first.\n');
  process.exit(1);
}

const orphans = [...present].filter((n) => !referenced.has(n)).length;
const mode = relativeRefs > 0 ? `whole-package (${ASSET_DIR}/ packed)` : `plan A CDN (${ASSET_DIR}/ excluded)`;
console.log(
  `✅ wechat package: shell intact, ${referenced.size} baked asset URLs all present in ${ASSET_DIR}/, single bundle, ` +
  `${mode}` +
  (orphans ? ` (${orphans} unreferenced file(s) left by earlier builds — expected under clean:false)` : '')
);
