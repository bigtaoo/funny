#!/usr/bin/env node
// Guards against the exact gap this script was written to close: socialsvc and botsvc were
// silently missing from CI's hand-enumerated `tsc -b shared engine metaserver ...` command line
// for weeks — package.json#workspaces had them, nobody noticed they got zero type-checking in CI.
//
// tsconfig.build.json (the solution file `tsc -b` now targets) must list every workspace from
// package.json#workspaces as a reference, and vice versa — this script fails if either side ever
// drifts from the other, so a newly added service can't quietly skip CI type-checking again.
//
// Usage: node scripts/checkWorkspaceCoverage.mjs   (cwd = server/)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8'));
const workspaces = new Set(pkg.workspaces ?? []);

const solution = JSON.parse(readFileSync(join(SERVER_ROOT, 'tsconfig.build.json'), 'utf8'));
const referenced = new Set((solution.references ?? []).map((r) => r.path));

const missingFromSolution = [...workspaces].filter((w) => !referenced.has(w));
const extraInSolution = [...referenced].filter((r) => !workspaces.has(r));

if (missingFromSolution.length === 0 && extraInSolution.length === 0) {
  console.log(`checkWorkspaceCoverage: OK — all ${workspaces.size} workspaces referenced in tsconfig.build.json.`);
  process.exit(0);
}

console.log('FAILED — server/package.json#workspaces and server/tsconfig.build.json#references have drifted apart:\n');
if (missingFromSolution.length) {
  console.log(`  In package.json#workspaces but NOT in tsconfig.build.json#references (gets zero CI type-checking):`);
  for (const w of missingFromSolution) console.log(`    - ${w}`);
}
if (extraInSolution.length) {
  console.log(`  In tsconfig.build.json#references but NOT in package.json#workspaces (stale/renamed entry):`);
  for (const r of extraInSolution) console.log(`    - ${r}`);
}
console.log('\n  -> add/remove the entry in tsconfig.build.json to match package.json#workspaces.');
process.exit(1);
