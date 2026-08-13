#!/usr/bin/env node
// Thin wrapper over the shared root scripts/checkFileLength.mjs (2026-08-13, G4 — tools/ had zero
// file-length coverage until now; client/server already had their own copies of this convention,
// this brings tools/ in line with the same rule instead of inventing a fourth one).
//
// Scans the whole tools/ tree in one pass (animator/level-editor/vfx-editor/map-editor/ops/
// desktop-shell each have their own src/, but none is big enough on its own to warrant a separate
// baseline file — one shared baseline here, same as this script's single invocation).
//
// Usage: node scripts/checkFileLength.mjs   (run with cwd = tools/).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', '..', 'scripts', 'checkFileLength.mjs');

const result = spawnSync(process.execPath, [
  SHARED,
  '--root=.',
  '--baseline=scripts/file-length-baseline.json',
], { stdio: 'inherit' });

process.exit(result.status ?? 1);
