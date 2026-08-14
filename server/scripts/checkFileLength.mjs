#!/usr/bin/env node
// Thin wrapper over the shared root scripts/checkFileLength.mjs (2026-08-13, G4 — this file and
// client's/tools' equivalents used to be ~95%-duplicated copies; merged into one script that a rule
// change only needs to land once). No server-specific exclusions beyond the shared defaults
// (generated/, scripts/, test files/dirs, .d.ts).
//
// Usage: node scripts/checkFileLength.mjs   (run with cwd = server/, same as the other *.mjs
// codegen scripts under server/*/scripts/).
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
