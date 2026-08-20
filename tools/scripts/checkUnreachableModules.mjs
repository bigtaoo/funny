#!/usr/bin/env node
// Thin wrapper over the shared root scripts/checkUnreachableModules.mjs, one invocation per tool
// package (2026-08-20 — added right after animator's 1424-line dead flat-module graph was deleted;
// see claudedocs/tools-testing.md 「已知遗留」 and claudedocs/animator.md).
//
// Per-package rather than one pass over tools/ (unlike the file-length wrapper next door): each
// package has its own bundler entry and its own `baseUrl`, and reachability is only meaningful
// relative to those. `desktop-shell` is deliberately absent — it is an Electron main/preload pair
// with no single-entry web bundle, so the model here doesn't fit it.
//
// `animator` is the one package needing --extra-root: runtime/StickmanRuntime.ts is a separate
// build product living OUTSIDE src/, so no entry imports it, and everything it pulls in would read
// as unreachable if it weren't its own root. That is not hypothetical — it is the trap the original
// one-off audit had to account for.
//
// Usage: node scripts/checkUnreachableModules.mjs   (run with cwd = tools/).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', '..', 'scripts', 'checkUnreachableModules.mjs');

/** One entry per package; `extraRoots` are directories outside src/ whose files are roots. */
const PACKAGES = [
  { pkg: 'animator', extraRoots: ['runtime'] },
  { pkg: 'level-editor', extraRoots: [] },
  { pkg: 'map-editor', extraRoots: [] },
  { pkg: 'ops', extraRoots: [] },
  { pkg: 'vfx-editor', extraRoots: [] },
];

let failed = 0;
for (const { pkg, extraRoots } of PACKAGES) {
  const argv = [SHARED, `--root=${pkg}`];
  if (extraRoots.length) argv.push(`--extra-root=${extraRoots.join(',')}`);
  process.stdout.write(`${pkg}: `);
  const result = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  if ((result.status ?? 1) !== 0) failed++;
}

if (failed) {
  console.log(`\n${failed}/${PACKAGES.length} tool package(s) have unreachable source files.`);
  process.exit(1);
}
process.exit(0);
