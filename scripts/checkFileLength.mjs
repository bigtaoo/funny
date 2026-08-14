#!/usr/bin/env node
// Shared baseline-drift check for the ">500-line source file" convention (claudedocs/server.md /
// claudedocs/client-modules.md, "单文件 500 行收敛"). Originally three near-identical copies lived
// under client/scripts, server/scripts, and (as of 2026-08-13) tools/scripts — merged into this one
// parameterized script so a fix/rule change lands once instead of drifting three ways again.
//
// Not a hard "fail if any file is over the limit" gate (would be permanently red for known,
// tracked debt) — it only fails on:
//   1. a file NOT in the baseline crosses LIMIT (a new god-file nobody signed off on), or
//   2. a file already in the baseline grows even bigger than its recorded line count
//      (known debt quietly getting worse instead of getting split), or
//   3. (2026-08-13, G3) a baseline entry has no `reason`, or its `lines` exceeds HARD_CAP (800) —
//      a file that size cannot be waved through as "justified", it must be split. This closes the
//      gap where 11 client files sat in the baseline for days with zero written justification and
//      nobody noticed (see claudedocs/client-modules.md's 2026-08-13 CI-gate-refactor note).
//
// Baseline schema (as of G3): { "_readme...": "prose, ignored — any "_"-prefixed key is a comment",
//   "path/to/File.ts": { "lines": 640, "reason": "why this file is a justified exception" } }
// A baseline file shrinking back under LIMIT is reported (info only, does not fail) as a reminder to
// delete its entry and move the note into the relevant claudedocs/*.md's "已完成" list.
//
// Usage: node scripts/checkFileLength.mjs --root=<dir> --baseline=<path> [--exclude-file=a,b,...]
//   [--exclude-prefix=x/,y/,...] [--limit=500] [--hard-cap=800]
// `--root` is resolved relative to cwd; exclude paths are relative to `--root`.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || !args.baseline) {
  console.error('Usage: node checkFileLength.mjs --root=<dir> --baseline=<path> [--exclude-file=a,b] [--exclude-prefix=x/,y/] [--limit=500] [--hard-cap=800]');
  process.exit(2);
}

const LIMIT = Number(args.limit ?? 500);
const HARD_CAP = Number(args['hard-cap'] ?? 800);
const ROOT = resolve(process.cwd(), args.root);
const BASELINE_PATH = resolve(process.cwd(), args.baseline);
const EXCLUDE_FILES = new Set((args['exclude-file'] ?? '').split(',').filter(Boolean));
const EXCLUDE_PREFIXES = (args['exclude-prefix'] ?? '').split(',').filter(Boolean);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git', 'scripts', 'coverage', '.cache', '.webpack']);
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__']);

/** Recursively collect .ts/.tsx source files under `dir`: no generated/, no scripts/, no test
 *  files/dirs, no .d.ts. */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || TEST_DIR_SEGMENTS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** wc -l semantics: count newline characters, not "number of segments after split". */
function countLines(absPath) {
  const content = readFileSync(absPath, 'utf8');
  if (content.length === 0) return 0;
  const segments = content.split('\n').length;
  return content.endsWith('\n') ? segments - 1 : segments;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

function isExcluded(relPath) {
  if (EXCLUDE_FILES.has(relPath)) return true;
  return EXCLUDE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const baselineKeys = Object.keys(baseline).filter((k) => !k.startsWith('_'));

// G3: every entry must be { lines, reason } — the old bare-number shape is rejected outright so a
// migration can't silently regress back to unexplained entries.
const schemaErrors = [];
for (const key of baselineKeys) {
  const v = baseline[key];
  if (typeof v !== 'object' || v === null || typeof v.lines !== 'number') {
    schemaErrors.push(`${key}: entry must be {"lines": <number>, "reason": "<string>"}, got ${JSON.stringify(v)}`);
    continue;
  }
  if (typeof v.reason !== 'string' || v.reason.trim().length < 15) {
    schemaErrors.push(`${key}: missing or too-short "reason" (must actually explain why this file is exempt, not just restate its size)`);
  }
  if (v.lines > HARD_CAP) {
    schemaErrors.push(`${key}: ${v.lines} lines exceeds the ${HARD_CAP}-line hard cap — no "reason" can justify a file this size in the baseline, it must be split`);
  }
}
if (schemaErrors.length) {
  console.log(`FAILED — ${toPosix(relative(process.cwd(), BASELINE_PATH))} has invalid entries:\n`);
  for (const e of schemaErrors) console.log(`  - ${e}`);
  process.exit(1);
}

const files = collectSourceFiles(ROOT).filter((absPath) => !isExcluded(toPosix(relative(ROOT, absPath))));

const violations = [];
const notices = [];
const seenBaselinePaths = new Set();
let overLimitCount = 0;

for (const absPath of files) {
  const relPath = toPosix(relative(ROOT, absPath));
  const lines = countLines(absPath);
  if (lines <= LIMIT) continue;
  overLimitCount++;

  const known = baseline[relPath];
  if (known === undefined) {
    violations.push(
      `NEW  ${relPath}: ${lines} lines (> ${LIMIT}), not in baseline.\n` +
      `     -> split it per the split-priority order (independent function modules > composition > chain),\n` +
      `        or if it's genuinely a one-off exception (and <= ${HARD_CAP} lines), add {"lines": ${lines}, "reason": "..."} to\n` +
      `        ${toPosix(relative(process.cwd(), BASELINE_PATH))} and log why in the relevant claudedocs/*.md.`,
    );
  } else {
    seenBaselinePaths.add(relPath);
    if (lines > known.lines) {
      violations.push(
        `GREW ${relPath}: ${lines} lines, baseline was ${known.lines} (+${lines - known.lines}).\n` +
        `     -> known debt got worse instead of getting split — update the baseline's "lines" only alongside\n` +
        `        an updated "reason" that actually explains the growth, don't bump it to silence this.`,
      );
    }
  }
}

for (const relPath of baselineKeys) {
  if (seenBaselinePaths.has(relPath)) continue;
  const absPath = join(ROOT, relPath);
  try {
    const lines = countLines(absPath);
    if (lines <= LIMIT) {
      notices.push(`${relPath} is now ${lines} lines (<= ${LIMIT}) — remove its baseline entry and move the note into the relevant claudedocs/*.md's "已完成" list.`);
    }
  } catch {
    notices.push(`${relPath} no longer exists on disk — remove it from the baseline.`);
  }
}

console.log(`checkFileLength(${toPosix(relative(process.cwd(), ROOT))}): scanned ${files.length} source files, ${overLimitCount} over ${LIMIT} lines (${baselineKeys.length} tracked in baseline).`);
if (notices.length) {
  console.log('\nHousekeeping (non-blocking):');
  for (const n of notices) console.log(`  - ${n}`);
}
if (violations.length) {
  console.log('\nFAILED — new or worsened violations of the 500-line convention:\n');
  for (const v of violations) console.log(v + '\n');
  process.exit(1);
}
console.log('OK — no new violations, no known files grew past their baseline, all baseline entries have a valid reason and are within the hard cap.');
