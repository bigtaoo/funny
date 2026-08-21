#!/usr/bin/env node
// Reachability gate: fails when a source file under --src is reachable from NOTHING — not the
// bundler entry, not a sibling product tree, not even a test.
//
// Why this exists (2026-08-20): tools/animator/src carried a complete pre-refactor copy of itself
// (11 flat modules + 2 `export {}` shells, 1424 lines) that only imported each other, so it looked
// alive from the inside and was invisible to both existing tools gates by construction — the files
// were under 500 lines (checkFileLength can't see them) and outside every coverage `include`
// (ADR-070's gated number can't see them either). It surfaced by accident, while someone happened
// to run a one-off import walk. This turns that walk into a gate so the next one doesn't need luck.
//
// What "reachable" means here is deliberately generous: a file counts as live if ANY root reaches
// it, including test files. A module that only tests import is not dead code — it is code whose
// only *caller* is a test, which is a different (and much weaker) smell that this gate has no
// opinion about. Only "literally nothing refers to this" fails.
//
// Resolution mirrors tsc/webpack for the shapes tools/ actually uses, and the candidate ORDER is
// load-bearing: `./skeleton` must try `skeleton.ts` BEFORE `skeleton/index.ts`, because that is
// exactly what made the animator graph self-closing (its dead `renderer.ts` imported `./skeleton`
// and got the dead flat `skeleton.ts`, not the live `skeleton/Skeleton.ts`). Get that order wrong
// and a dead graph reads as live.
//
// Non-relative specifiers are tried under --src (tsconfig `baseUrl`), and anything that resolves
// outside --root (npm packages, `@nw/*` cross-package aliases) is simply not followed: this gate
// only judges files inside the package it was pointed at.
//
// Usage: node scripts/checkUnreachableModules.mjs --root=<dir> [--src=src] [--entry=a.ts,b.ts]
//   [--extra-root=runtime,worker] [--test-dir=test]
//   --entry defaults to <src>/index.ts. --extra-root takes DIRECTORIES whose every .ts file is a
//   root (a sibling build product like animator's runtime/, which no entry imports). Paths are
//   relative to --root; --root itself is resolved against cwd.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root) {
  console.error(
    'Usage: node checkUnreachableModules.mjs --root=<dir> [--src=src] [--entry=a.ts,b.ts] ' +
      '[--extra-root=runtime] [--test-dir=test]',
  );
  process.exit(2);
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function rel(absPath) {
  return toPosix(relative(ROOT, absPath));
}

const ROOT = resolve(process.cwd(), args.root);
const SRC_REL = args.src ?? 'src';
const SRC = join(ROOT, SRC_REL);
// Default spelled with '/' rather than join(): it is echoed in the OK/FAILED output, and a
// backslash there would make this gate's messages differ between CI (linux) and a Windows dev box.
const ENTRIES = (args.entry ?? `${toPosix(SRC_REL)}/index.ts`).split(',').filter(Boolean);
const EXTRA_ROOT_DIRS = (args['extra-root'] ?? '').split(',').filter(Boolean);
const TEST_DIRS = (args['test-dir'] ?? 'test').split(',').filter(Boolean);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git', 'coverage', '.cache', '.webpack']);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Every code file under `dir`, recursively. `filter` sees the entry name. */
function collect(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) collect(p, filter, out);
    } else if (e.isFile() && filter(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const isSourceName = (name) =>
  CODE_EXT.test(name) && !name.endsWith('.d.ts') && !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name);
const isTestName = (name) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name);

// Matches `import ... from 'x'`, `export ... from 'x'`, bare `import 'x'`, `import('x')` and
// `require('x')`. `[^;]*?` (not `.`) so multi-line import lists are covered — `.` would stop at the
// first newline and silently miss every wrapped import, which reads as "unreachable".
const SPEC_RE =
  /(?:^|[\s;{}()])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;{}()])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve `spec` as written in `fromFile`, or null. Candidate order matches tsc's. */
function resolveSpec(spec, fromFile) {
  const bases = spec.startsWith('.') ? [resolve(dirname(fromFile), spec)] : [resolve(SRC, spec)];
  for (const base of bases) {
    const candidates = [];
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(base + ext);
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(join(base, 'index' + ext));
    candidates.push(base);
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

function insideRoot(absPath) {
  const r = relative(ROOT, absPath);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

const reached = new Set();

function walk(absFile) {
  const key = resolve(absFile);
  if (reached.has(key)) return;
  reached.add(key);
  if (!CODE_EXT.test(key)) return;
  let text;
  try {
    text = readFileSync(key, 'utf8');
  } catch {
    return;
  }
  SPEC_RE.lastIndex = 0;
  let m;
  while ((m = SPEC_RE.exec(text))) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!spec) continue;
    const target = resolveSpec(spec, key);
    // Unresolvable (npm package) or outside this package (cross-package alias): not ours to judge.
    if (target && insideRoot(target)) walk(target);
  }
}

// ── Roots ─────────────────────────────────────────────────────────────────────
const roots = [];
const missingEntries = [];
for (const e of ENTRIES) {
  const p = resolve(ROOT, e);
  if (existsSync(p)) roots.push(p);
  else missingEntries.push(e);
}
for (const d of EXTRA_ROOT_DIRS) roots.push(...collect(join(ROOT, d), isSourceName));
for (const d of TEST_DIRS) roots.push(...collect(join(ROOT, d), isTestName));

// A mistyped --entry is the single most likely way this gate goes quietly useless: drop the real
// entry and almost every file reports unreachable, which reads as a false alarm and gets muted.
// Louder to say the entry is missing.
if (missingEntries.length) {
  console.log(
    `FAILED — entry not found under ${rel(ROOT) || '.'}: ${missingEntries.join(', ')}. ` +
      `Fix --entry (or the wrapper that passes it); every file below is measured against these roots.`,
  );
  process.exit(1);
}

const auditSet = collect(SRC, isSourceName);

// Canary, same reasoning as checkFileLength.mjs'/checkDocLinks.mjs': "scanned nothing" and "found
// nothing wrong" print the same OK below. A wrong --root or --src, or a widened EXCLUDE_DIRS, and
// this gate passes by doing nothing at all.
if (auditSet.length === 0) {
  console.log(
    `FAILED — scanned 0 source files under ${toPosix(relative(process.cwd(), SRC))}. ` +
      `This run proves nothing (wrong --root/--src, or the exclude rules now match everything).`,
  );
  process.exit(1);
}
if (roots.length === 0) {
  console.log(
    `FAILED — 0 roots to walk from under ${rel(ROOT) || '.'}. With no roots every file is trivially ` +
      `unreachable, so the report below would be pure noise.`,
  );
  process.exit(1);
}

for (const r of roots) walk(r);

const unreachable = auditSet.filter((f) => !reached.has(resolve(f))).map(rel).sort();

if (unreachable.length) {
  console.log(
    `FAILED — ${unreachable.length} unreachable source file(s) under ${rel(SRC)}: nothing imports ` +
      `them, directly or transitively, from any of ${roots.length} root(s).\n`,
  );
  for (const f of unreachable) console.log(`  - ${f}`);
  console.log(
    `\nEither delete them, or make them reachable. If they ARE a legitimate separate product ` +
      `(a second bundler entry, a sibling runtime/ tree), pass it via --entry / --extra-root — ` +
      `do not silence this by deleting the check.\n` +
      `Beware same-name twins before deleting: ./x can resolve to x.ts rather than x/index.ts, so ` +
      `verify each path individually (see claudedocs/tools-testing.md).`,
  );
  process.exit(1);
}

console.log(
  `OK — all ${auditSet.length} source file(s) under ${rel(SRC)} are reachable from ` +
    `${roots.length} root(s) (${ENTRIES.join(', ')}${EXTRA_ROOT_DIRS.length ? ` + ${EXTRA_ROOT_DIRS.join(', ')}/` : ''}` +
    `${TEST_DIRS.length ? ` + ${TEST_DIRS.join(', ')}/` : ''}).`,
);
