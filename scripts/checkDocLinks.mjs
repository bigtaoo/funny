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
//   3. orphans: a tracked .md nothing links to (added 2026-08-20, ADR-067 round 5 — the
//      failure mode of a doc SPLIT, where a new spoke file silently never gets linked from
//      the hub and becomes invisible instead of broken)
//   4. source paths named in prose — `server/metaserver/src/foo.ts` — that no longer exist
//      (added 2026-09-15). Checks 1-3 only see markdown LINKS, and almost nothing here links
//      to code; the repo names code inline in backticks instead. That left ~160 dead paths
//      the gate could not see, most of them from two mass refactors nobody swept the docs for:
//      the server monolith splitting into workspaces (`server/src/x.ts` -> `server/metaserver/src/x.ts`)
//      and scene `base.ts` becoming `core.ts`.
// Oversized docs are reported as a non-blocking notice only.
//
// Usage: node scripts/checkDocLinks.mjs [--quiet]
// Exits 1 on any broken link, broken anchor, orphan, or dead source path.
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
import { resolve, dirname, join, relative, sep } from 'node:path';

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

/** Repo-relative POSIX paths of every .md that some OTHER .md links to (see the orphan check). */
const linkedMd = new Set();
const relPosix = (abs) => relative(process.cwd(), abs).split(sep).join('/');

/** A .md with no inbound link is fine only if something outside the docs graph points at it:
 *  a README.md is its directory's index (GitHub renders it as such), and CLAUDE.md is loaded by
 *  the harness, not linked. Anything else needs an inbound link or an entry here WITH a reason. */
const ROOT_DOCS = new Set(['CLAUDE.md']);
const isRootDoc = (rel) => ROOT_DOCS.has(rel) || rel === 'README.md' || rel.endsWith('/README.md');

const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

// --- check 4: source paths named in prose -------------------------------------------------
// A mention only counts if it starts at a top-level directory AND ends in a file extension,
// so ordinary prose ("改 server/ 那侧") is never flagged. The leading boundary matters more
// than it looks: without it, `gameserver/index.ts` contains the substring `server/index.ts`
// and every service entry point reads as a dead path.
const PATH_ROOTS = ['client/', 'server/', 'tools/', 'art/', 'design/', 'claudedocs/', 'scripts/', 'docker/', 'wrangler/'];
const PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_\\-./@])(?:${PATH_ROOTS.join('|')})[A-Za-z0-9_\\-./@]+`, 'g');
const PATH_EXT_RE = /\.(tsx?|[cm]?js|json|ya?ml|proto|py|md|html|css|sh|png|webp|jpe?g|ogg|mp3)$/i;

/** Mentions that are correct as written even though nothing resolves. Each needs a reason:
 *  the point of the gate is that "it's fine, trust me" has to be written down once. */
const PATH_ALLOW = new Map([
  ['client/portrait-report/', 'gitignored render report, produced on demand'],
  ['server/node_modules/', 'dependency tree, not source'],
  ['design/xxx.md', 'literal placeholder in a worktrees.md example'],
  ['design/04-wechat.md', 'a doc in the D:\\daydayup repo, not this one'],
  ['server/analyticsvc/_scratch_mongo.mjs', 'throwaway probe, deliberately never committed'],
  ['scripts/gen-proto.mjs', 'every workspace has its own; the docs mean it generically'],
]);
/** Deliberately-deleted files that dated log entries still name. The entry IS the history of
 *  the deletion — rewriting the path would make the entry lie. Only add a file here after
 *  reading the passage and confirming it says the thing is gone. */
const PATH_ALLOW_HISTORICAL = new Map([
  ['client/test/equipmentFormulaParity.test.ts', 'added and deleted the same day, ADR-087'],
  ['client/test/render/iconArtPromptCoverage.test.ts', 'deleted on purpose once the backlog it guarded emptied'],
  ['client/test/difficulty/_scan.test.ts', 'explicitly a run-once-then-delete calibration probe'],
  ['client/test/ui/worldMapScoutDisabled.ui.ts', 'deleted with scout march, 7bfb1ef75'],
  ['server/worldsvc/test/scout.e2e.test.ts', 'deleted with scout march, 7bfb1ef75'],
  ['server/test/compliance.test.ts', 'deleted as a fake-assertions suite, 2229c1811'],
  ['client/src/scenes/CollectionScene.ts', 'dissolved into Develop/Career tabs, b4f5cae38'],
  ['client/src/scenes/TeamsScene.ts', 'scene removed'],
  ['client/src/game/fx/filters.ts', 'module removed'],
  ['client/scripts/prepare-gacha-assets.mjs', 'replaced by art/scripts/exportGachaArt.mjs, deletion is the point of the entry'],
  ['client/src/assets/factions/factions.json', 'merged into icons_atlas; the passage explains the merge'],
  ['art/ui/head/pack_avatar_atlas.cjs', 'packing script removed'],
  ['art/ui/panelframe/panelframe_base.png', 'art never committed'],
  ['art/units/manifest.json', 'workspace-sync experiment, taken down 2026-08-02'],
  ['tools/animator/scripts/anim-sync.mjs', 'workspace-sync experiment, taken down 2026-08-02'],
]);

const allowReason = (p) => {
  if (p.includes('/.../')) return 'prose elides the middle of a long path';
  for (const [k, why] of PATH_ALLOW) if (p === k || p.startsWith(k)) return why;
  return PATH_ALLOW_HISTORICAL.get(p) ?? null;
};

/** Docs name paths from the repo root, but also relative to themselves ("design/README.md"
 *  writing `tools/map-editor/DESIGN.md` means design/tools/...). Accept either. */
function pathResolves(p, docDir) {
  if (existsSync(p)) return true;
  const parts = docDir ? docDir.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const base = parts.slice(0, i).join('/');
    if (existsSync(base ? join(base, p) : p)) return true;
  }
  return false;
}

const deadPaths = [];
let pathsChecked = 0;

for (const rel of files) {
  const text = readFileSync(rel, 'utf8');
  const lineOf = (idx) => text.slice(0, idx).split(/\r?\n/).length;

  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > LINE_NOTICE_LIMIT) oversize.push({ rel, lineCount });

  const docDir = dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/');
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/[.,;:)`]+$/, '').replace(/:\d+(-\d+)?$/, '');
    if (!PATH_EXT_RE.test(p)) continue;
    pathsChecked++;
    if (pathResolves(p, docDir) || allowReason(p)) continue;
    deadPaths.push({ rel, line: lineOf(m.index), target: p });
  }

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
    if (/\.md$/i.test(path) && statSync(abs).isFile()) {
      // Self-links don't count as inbound: a doc must not be able to vouch for itself.
      if (relPosix(abs) !== rel) linkedMd.add(relPosix(abs));
      if (anchor && !anchorsOf(abs).has(decodeURIComponent(anchor).toLowerCase()))
        brokenAnchors.push({ rel, line: lineOf(m.index), target });
    }
  }
}

// Canary: if this ever hits zero the scan silently stopped working (CRLF bug, bad
// glob, wrong cwd) and every check below would pass vacuously.
if (files.length === 0 || linksChecked === 0 || pathsChecked === 0) {
  console.error(
    `checkDocLinks: FAILED — scanned ${files.length} files and found ${linksChecked} relative links ` +
      `and ${pathsChecked} source-path mentions. Expected hundreds of each; the scan itself is broken ` +
      `(wrong cwd, or git ls-files returned nothing).`
  );
  process.exit(1);
}

console.log(
  `checkDocLinks: ${files.length} markdown files, ${linksChecked} relative links, ` +
    `${pathsChecked} source-path mentions checked.`
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

// Orphans: in-degree zero, not reachability from a root — deliberately the weaker of the two.
// "Does anything link to this file" is as objective as "does this link resolve"; "is it reachable
// from CLAUDE.md" would need a root set and would flag whole legitimately-standalone subtrees.
const orphans = files.filter((rel) => !isRootDoc(rel) && !linkedMd.has(rel));
if (orphans.length) {
  console.log(`\nFAILED — ${orphans.length} markdown file(s) that nothing links to:`);
  for (const o of orphans) console.log(`  ${o}`);
  console.log(
    '  A doc no page points at is invisible, not broken — nobody finds it to notice it rotted. ' +
      'This is what a doc split gets wrong: the hub gets written, one spoke never gets linked.\n' +
      '  Fix by linking it from the doc that owns the topic (preferred — that is the point), or, if it ' +
      'genuinely has no inbound owner, add it to ROOT_DOCS in this script with a comment saying why.'
  );
}

report('link(s) pointing at a file that does not exist', brokenFiles,
  'Usually a wrong relative depth (a doc in design/game/archive/ linking a sibling as if it were in design/game/), or a file that was renamed or split.');
report('anchor(s) with no matching heading', brokenAnchors,
  'The heading was reworded, or moved into a spoke file — repoint at the file that now holds it. Anchor = heading lowercased, punctuation dropped, spaces to dashes.');

report('source path(s) named in prose that do not exist', deadPaths,
  'Point it at where the code lives NOW — `git log --diff-filter=D -1 -- <path>` names the commit that moved or deleted it. ' +
  'Two exceptions, both needing an entry in this script: a path that is correct as written but unresolvable ' +
  '(generated output, another repo, a per-workspace script meant generically) goes in PATH_ALLOW; a dated log entry ' +
  'whose whole subject IS the deletion goes in PATH_ALLOW_HISTORICAL — rewriting that path would make the entry lie. ' +
  'Read the passage before choosing: most dead paths are rot, not history.');

if (brokenFiles.length || brokenAnchors.length || orphans.length || deadPaths.length) process.exit(1);
console.log('OK — every relative markdown link, anchor and source path resolves, and every doc has an inbound link.');
