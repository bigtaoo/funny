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
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TEST_ROOT = join(HERE, '..', 'dist', '__tests__');

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

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
