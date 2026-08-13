#!/usr/bin/env node
// Auto-discovers compiled test files under dist/__tests__/ and runs them via `node --test`.
// Replaces a hand-enumerated file list in package.json's "test" script (2026-08-13, G5) — a new
// test file used to need a matching manual edit there, and nobody would notice a forgotten one
// silently not running. `node --test <dir>` was tried first but proved unreliable on this repo's
// Windows/Node combination (sometimes recursed the whole cwd including unstrippable src/**/*.ts,
// sometimes failed to resolve the directory arg at all) — explicit file args sidesteps both.
//
// Only *.test.js directly under dist/__tests__/ (recursively) is included — .js.map / helper
// scripts like goldenReplay/generateFixtures.js and goldenReplay/verifyFpMigration.js are not test
// files and must not be picked up as one.
//
// --coverage: opts into Node's built-in coverage (--experimental-test-coverage) instead of
// pulling in a separate instrumentation dependency (c8/istanbul) — engine already runs its
// compiled dist/ output straight through `node --test`, so Node's own V8-backed coverage applies
// with no extra tooling. Emits the usual spec-style pass/fail + text coverage table to stdout
// (mirrors plain `npm test`), plus an lcov file under coverage/ so CI's aggregation step can read
// it alongside the vitest workspaces' lcov output.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TEST_ROOT = join(HERE, '..', 'dist', '__tests__');
const COVERAGE = process.argv.includes('--coverage');

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const files = collect(TEST_ROOT).sort();
if (files.length === 0) {
  console.error(`No *.test.js files found under ${TEST_ROOT} — did the build step run first?`);
  process.exit(1);
}
console.log(`runTests: discovered ${files.length} test files under dist/__tests__/`);
for (const f of files) console.log(`  - ${relative(join(HERE, '..'), f).split('\\').join('/')}`);

const coverageArgs = [];
if (COVERAGE) {
  const coverageDir = join(HERE, '..', 'coverage');
  mkdirSync(coverageDir, { recursive: true });
  coverageArgs.push(
    '--experimental-test-coverage',
    '--test-coverage-exclude=**/__tests__/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${join(coverageDir, 'lcov.info')}`,
  );
}

const result = spawnSync(process.execPath, ['--test', ...coverageArgs, ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
