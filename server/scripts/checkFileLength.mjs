#!/usr/bin/env node
// Baseline-drift check for the "server/ source files should stay <=500 lines" convention
// (claudedocs/server.md, "单文件 500 行收敛"). Mirrors the existing codegen-staleness-check
// pattern used elsewhere in CI (bundle/gen-*.mjs + `git diff --exit-code`): instead of a hard
// "fail if any file is over the limit" gate (which would be permanently red — 27 known files
// are over 500 today and are tracked as backlog, not blocked on), this only fails on genuine
// *regressions*:
//   1. a file NOT in the baseline crosses the limit (a new god-file nobody signed off on), or
//   2. a file already in the baseline grows even bigger than its recorded line count
//      (known debt quietly getting worse instead of getting split).
// A baseline file shrinking back under the limit is reported (info only, does not fail) as a
// reminder to shrink file-length-baseline.json and move the entry out of claudedocs/server.md's
// backlog list into the "试点/已完成" section.
//
// Usage: node scripts/checkFileLength.mjs   (run with cwd = server/, same as the other *.mjs
// codegen scripts under server/*/scripts/).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 500;
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'file-length-baseline.json');

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git', 'scripts', 'coverage']);
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__']);

/** Recursively collect .ts source files under `dir`, applying the same exclusions as the
 *  original 500-line audit (no generated/ output, no scripts/, no test files/dirs, no .d.ts). */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || TEST_DIR_SEGMENTS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue; // covers both *.test.ts and *.e2e.test.ts
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

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const files = collectSourceFiles(SERVER_ROOT);

const violations = [];
const notices = [];
const seenBaselinePaths = new Set();
let overLimitCount = 0;

for (const absPath of files) {
  const relPath = toPosix(relative(SERVER_ROOT, absPath));
  const lines = countLines(absPath);
  if (lines <= LIMIT) continue;
  overLimitCount++;

  const known = baseline[relPath];
  if (known === undefined) {
    violations.push(
      `NEW  ${relPath}: ${lines} lines (> ${LIMIT}), not in baseline.\n` +
      `     -> split it per claudedocs/server.md's priority order (module > composition > chain),\n` +
      `        or if it's genuinely a one-off exception, add it to ${toPosix(relative(SERVER_ROOT, BASELINE_PATH))} and log why in claudedocs/server.md.`,
    );
  } else {
    seenBaselinePaths.add(relPath);
    if (lines > known) {
      violations.push(
        `GREW ${relPath}: ${lines} lines, baseline was ${known} (+${lines - known}).\n` +
        `     -> known debt got worse instead of getting split — see claudedocs/server.md's priority order.`,
      );
    }
  }
}

for (const relPath of Object.keys(baseline)) {
  if (relPath.startsWith('_')) continue; // e.g. _readme — not a file entry
  if (seenBaselinePaths.has(relPath)) continue;
  const absPath = join(SERVER_ROOT, relPath);
  try {
    const lines = countLines(absPath);
    if (lines <= LIMIT) {
      notices.push(`${relPath} is now ${lines} lines (<= ${LIMIT}) — remove it from the baseline and move it into claudedocs/server.md's "已完成" list.`);
    }
  } catch {
    notices.push(`${relPath} no longer exists on disk — remove it from the baseline.`);
  }
}

const baselineCount = Object.keys(baseline).filter((k) => !k.startsWith('_')).length;
console.log(`checkFileLength: scanned ${files.length} server/ source files, ${overLimitCount} over ${LIMIT} lines (${baselineCount} tracked in baseline).`);
if (notices.length) {
  console.log('\nHousekeeping (non-blocking):');
  for (const n of notices) console.log(`  - ${n}`);
}
if (violations.length) {
  console.log('\nFAILED — new or worsened violations of the 500-line convention:\n');
  for (const v of violations) console.log(v + '\n');
  process.exit(1);
}
console.log('OK — no new violations, no known files grew past their baseline.');
