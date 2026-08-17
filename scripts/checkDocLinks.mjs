#!/usr/bin/env node
// Repo-wide markdown link/anchor gate (ADR-067 round 3, 2026-08-17).
//
// The 500-line doc convention deliberately has NO CI gate — docs must be cut along
// semantic seams (spec vs log vs lookup table), and a hard line limit pushes toward
// mechanical cuts that read worse. See ADR-067. What IS worth gating is link rot,
// which is objective: a link either resolves or it doesn't.
//
// Checks every tracked *.md file for:
//   1. relative links whose target file/directory does not exist
//   2. `#anchor` fragments into .md files with no heading that slugifies to them
// Oversized docs are reported as a non-blocking notice only.
//
// Usage: node scripts/checkDocLinks.mjs [--quiet]
// Exits 1 on any broken link or anchor.
//
// Two things this script gets right that a naive version does not, both of which
// fail SILENTLY (a naive version passes vacuously and you learn nothing):
//   - split(/\r?\n/), never split('\n'): most docs here are CRLF, and JS regex `.`
//     excludes \r, so /^(#{1,3})\s+(.*)$/ matches NOTHING on a CRLF line. A trailing
//     \r also counts as \s, so slug() would emit a stray '-' and every anchor into a
//     CRLF file would look broken.
//   - anchor slugs strip Unicode punctuation via \p{P}\p{S}, not an ASCII blacklist:
//     these headings are full of full-width （）：，「」 which GitHub also strips.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

const QUIET = process.argv.includes('--quiet');
const LINE_NOTICE_LIMIT = 500;

let files;
try {
  files = execSync('git ls-files "*.md"', { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error(
    `checkDocLinks: FAILED — \`git ls-files\` did not run. This script must be invoked from ` +
      `inside the repo (it scans tracked files repo-wide, so cwd matters).\n  ${err.message.trim()}`
  );
  process.exit(1);
}

/** GitHub (github-slugger) rule: lowercase, drop punctuation/symbols except - and _,
 *  spaces -> '-'. CJK ideographs are kept verbatim. */
const slug = (heading) =>
  heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (c) => (c === '-' || c === '_' ? c : ''))
    .replace(/\s/g, '-');

const anchorCache = new Map();
/** All anchors a markdown file exposes, including GitHub's -1/-2 duplicate suffixes.
 *  Headings inside ``` fences don't count — they are code, not structure. */
function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const seen = new Map();
  const out = new Set();
  let inFence = false;
  for (const line of readFileSync(absPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !/^#{1,6}\s/.test(line)) continue;
    const base = slug(line);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  anchorCache.set(absPath, out);
  return out;
}

const brokenFiles = [];
const brokenAnchors = [];
const oversize = [];
let linksChecked = 0;

const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

for (const rel of files) {
  const text = readFileSync(rel, 'utf8');
  const lineOf = (idx) => text.slice(0, idx).split(/\r?\n/).length;

  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > LINE_NOTICE_LIMIT) oversize.push({ rel, lineCount });

  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1];
    if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;   // external / same-page
    if (/\{\{.*\}\}/.test(target)) continue;                   // template placeholder

    let [path, anchor] = target.split('#');
    if (!path) continue;
    path = path.replace(/:\d+(-\d+)?$/, '');                   // `Foo.ts:259` source deep link
    linksChecked++;

    const abs = resolve(dirname(resolve(rel)), decodeURIComponent(path));
    if (!existsSync(abs)) {
      brokenFiles.push({ rel, line: lineOf(m.index), target });
      continue;
    }
    if (anchor && /\.md$/i.test(path) && statSync(abs).isFile()) {
      if (!anchorsOf(abs).has(decodeURIComponent(anchor).toLowerCase()))
        brokenAnchors.push({ rel, line: lineOf(m.index), target });
    }
  }
}

// Canary: if this ever hits zero the scan silently stopped working (CRLF bug, bad
// glob, wrong cwd) and every check below would pass vacuously.
if (files.length === 0 || linksChecked === 0) {
  console.error(
    `checkDocLinks: FAILED — scanned ${files.length} files and found ${linksChecked} relative links. ` +
      `Expected hundreds; the scan itself is broken (wrong cwd, or git ls-files returned nothing).`
  );
  process.exit(1);
}

console.log(
  `checkDocLinks: ${files.length} markdown files, ${linksChecked} relative links checked.`
);

if (!QUIET && oversize.length) {
  console.log(
    `\nNotice (non-blocking): ${oversize.length} file(s) over ${LINE_NOTICE_LIMIT} lines. ` +
      `ADR-067 asks for semantic splits, so this is never a hard failure:`
  );
  for (const o of oversize.sort((a, b) => b.lineCount - a.lineCount).slice(0, 15))
    console.log(`  ${String(o.lineCount).padStart(5)}  ${o.rel}`);
}

const report = (label, arr, hint) => {
  if (!arr.length) return;
  console.log(`\nFAILED — ${arr.length} ${label}:`);
  for (const b of arr) console.log(`  ${b.rel}:${b.line} -> ${b.target}`);
  console.log(`  ${hint}`);
};

report('link(s) pointing at a file that does not exist', brokenFiles,
  'Usually a wrong relative depth (a doc in design/game/archive/ linking a sibling as if it were in design/game/), or a file that was renamed or split.');
report('anchor(s) with no matching heading', brokenAnchors,
  'The heading was reworded, or moved into a spoke file — repoint at the file that now holds it. Anchor = heading lowercased, punctuation dropped, spaces to dashes.');

if (brokenFiles.length || brokenAnchors.length) process.exit(1);
console.log('OK — every relative markdown link and anchor resolves.');
