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

//
// Second gap, closed 2026-08-19 the same way: `tsconfig.json` is src-only in every workspace and
// vitest runs through esbuild (types erased, never checked), so a workspace's whole test/ tree got
// ZERO type-checking unless it also has a `tsconfig.test.json` + a `typecheck:test` script that CI
// runs. That is now required of every workspace too, so a newly added service can't quietly skip it.
//
// Third gap, closed 2026-08-20: a `tsconfig.test.json` can still carve a file back out via `exclude`,
// which is how auction-fulllink.e2e.test.ts spent a day as the one unchecked server test file. An
// exclusion is legitimate ONLY if some other program picks the file up -- today that is
// client/tsconfig.fulllink.json, the cross-package program for server tests that import client source.
// So every path excluded from a test program must appear in that program's `include`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--root=<dir>` points the whole check at a different server/ tree; defaults to this script's own
// (the only thing CI ever wants). It exists so the check is testable against fixture trees instead of
// only against the real repo — same flag and spelling as the sibling scripts/checkFileLength.mjs.
const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
const SERVER_ROOT = rootArg
  ? resolve(process.cwd(), rootArg.slice('--root='.length))
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8'));
const workspaces = new Set(pkg.workspaces ?? []);

// Canary (same reasoning as scripts/checkDocLinks.mjs'): with zero workspaces every loop below is a
// no-op and the script would report a cheerful "OK — all 0 workspaces", i.e. pass vacuously. A guard
// that fails by turning green is worse than no guard.
if (workspaces.size === 0) {
  console.log(
    `checkWorkspaceCoverage: FAILED — ${join(SERVER_ROOT, 'package.json')} lists no workspaces. ` +
      `Every check here iterates that list, so there is nothing to verify and this run proves nothing.`,
  );
  process.exit(1);
}

const solution = JSON.parse(readFileSync(join(SERVER_ROOT, 'tsconfig.build.json'), 'utf8'));
const referenced = new Set((solution.references ?? []).map((r) => r.path));

const missingFromSolution = [...workspaces].filter((w) => !referenced.has(w));
const extraInSolution = [...referenced].filter((r) => !workspaces.has(r));

// Every workspace must also carry the test-program type-check (see the header note): a
// tsconfig.test.json next to its tsconfig.json, plus the `typecheck:test` script the root
// `npm run typecheck:test` fans out to via --workspaces --if-present ("--if-present" is exactly
// why a missing script would otherwise be silently skipped instead of failing).
const missingTestConfig = [];
const missingTestScript = [];
for (const w of workspaces) {
  if (!existsSync(join(SERVER_ROOT, w, 'tsconfig.test.json'))) missingTestConfig.push(w);
  const wsPkg = JSON.parse(readFileSync(join(SERVER_ROOT, w, 'package.json'), 'utf8'));
  if (!wsPkg.scripts?.['typecheck:test']) missingTestScript.push(w);
}

// A test file carved out of its workspace's test program (see the header's third note) is only OK if
// the cross-package program owns it instead. Compare as repo-relative POSIX paths so the two sides --
// `exclude` relative to server/<ws>/, `include` relative to client/ -- are directly comparable.
const REPO_ROOT = resolve(SERVER_ROOT, '..');
const FULLLINK = join(REPO_ROOT, 'client', 'tsconfig.fulllink.json');
const rel = (base, p) => relative(REPO_ROOT, resolve(base, p)).split(sep).join('/');
const fulllinkIncludes = existsSync(FULLLINK)
  ? new Set((JSON.parse(readFileSync(FULLLINK, 'utf8')).include ?? []).map((i) => rel(dirname(FULLLINK), i)))
  : null;
const unowned = [];
const globbedExcludes = [];
for (const w of workspaces) {
  const cfgPath = join(SERVER_ROOT, w, 'tsconfig.test.json');
  if (!existsSync(cfgPath)) continue;
  for (const ex of JSON.parse(readFileSync(cfgPath, 'utf8')).exclude ?? []) {
    // Globs would make "is this file checked somewhere?" undecidable here, so they are not allowed.
    if (/[*?]/.test(ex)) { globbedExcludes.push(`${w}: ${ex}`); continue; }
    const p = rel(join(SERVER_ROOT, w), ex);
    if (fulllinkIncludes === null || !fulllinkIncludes.has(p)) unowned.push(`${w}: ${ex} -> ${p}`);
  }
}

// Fourth gap, closed 2026-08-21: every check above reads package.json#workspaces, and so does every
// CI fan-out in the repo (`tsc -b` on the solution file, `npm run <x> --workspaces --if-present`,
// coverageLib.mjs's package list). A package under server/ that is NOT a workspace is therefore
// invisible to all of them at once: server/tools/econ-sim had 18 tests and a typecheck script and
// CI ran neither, ever, while it imported @nw/shared/@nw/engine numeric constants and was edited as
// late as ADR-069 (2026-08-19). Rule: a non-workspace package under server/ that has a `test` script
// must be named by a ci.yml step that runs it (plus its `typecheck` script, if it has one).
// Enumerating from disk is the point — that is what makes forgetting one impossible, exactly as the
// workspaces/references check above does for services.
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
// Steps are split on `- name:` and each chunk's `working-directory:` + `run:` body is matched as
// text. A YAML parse would be more precise and needs a dependency this repo's scripts deliberately
// don't have; the shapes ci.yml actually uses are all single-line `working-directory:` values.
const ciSteps = existsSync(CI_YML)
  ? readFileSync(CI_YML, 'utf8')
      .split(/^\s*- name:/m)
      .slice(1)
      .map((chunk) => ({
        dir: /^\s*working-directory:\s*(\S+)\s*$/m.exec(chunk)?.[1],
        body: chunk,
      }))
  : null;
// `(?![\w:-])` so `npm run test:coverage` does not count as running a `test` script (nor
// `typecheck:test` as `typecheck`) — a near-miss step name is exactly the kind of thing that would
// make this check pass while the script it names never runs.
const SCRIPT_PATTERNS = { test: /npm (run )?test(?![\w:-])/, typecheck: /npm run typecheck(?![\w:-])/ };
const uncheckedPackages = [];
const findPackages = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['node_modules', 'dist', 'coverage', '.git', 'generated'].includes(entry.name)) continue;
    if (dir === SERVER_ROOT && workspaces.has(entry.name)) continue; // handled by every check above
    const sub = join(dir, entry.name);
    if (existsSync(join(sub, 'package.json'))) out.push(sub);
    findPackages(sub, out);
  }
  return out;
};
if (ciSteps !== null) {
  for (const pkgDir of findPackages(SERVER_ROOT)) {
    const scripts = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts ?? {};
    if (!scripts.test) continue; // nothing to run in CI; not this check's business
    const dirRel = relative(REPO_ROOT, pkgDir).split(sep).join('/');
    const steps = ciSteps.filter((s) => s.dir === dirRel);
    for (const script of ['test', 'typecheck']) {
      if (!scripts[script]) continue;
      if (!steps.some((s) => SCRIPT_PATTERNS[script].test(s.body))) {
        uncheckedPackages.push(`${dirRel}: has a "${script}" script that no ci.yml step runs`);
      }
    }
  }
}

if (missingFromSolution.length === 0 && extraInSolution.length === 0
  && missingTestConfig.length === 0 && missingTestScript.length === 0
  && unowned.length === 0 && globbedExcludes.length === 0 && uncheckedPackages.length === 0) {
  console.log(`checkWorkspaceCoverage: OK — all ${workspaces.size} workspaces referenced in tsconfig.build.json, each with a tsconfig.test.json + typecheck:test script; every excluded test file owned by client/tsconfig.fulllink.json; every non-workspace package with tests wired into ci.yml.`);
  process.exit(0);
}

if (uncheckedPackages.length) {
  console.log('FAILED — a non-workspace package under server/ has scripts that CI never runs (no --workspaces fan-out reaches it):\n');
  for (const u of uncheckedPackages) console.log(`    - ${u} (add a ci.yml step with \`working-directory: <that path>\`, or drop the script)`);
  if (missingFromSolution.length === 0 && extraInSolution.length === 0
    && missingTestConfig.length === 0 && missingTestScript.length === 0
    && unowned.length === 0 && globbedExcludes.length === 0) process.exit(1);
  console.log('');
}

if (unowned.length || globbedExcludes.length) {
  console.log('FAILED — a test file is excluded from its workspace test program without another program owning it:\n');
  for (const u of unowned) console.log(`    - ${u} (add that path to client/tsconfig.fulllink.json#include, or drop the exclude)`);
  for (const g of globbedExcludes) console.log(`    - ${g} (glob excludes are not allowed in tsconfig.test.json — list files literally so this check stays decidable)`);
  if (missingFromSolution.length === 0 && extraInSolution.length === 0
    && missingTestConfig.length === 0 && missingTestScript.length === 0) process.exit(1);
  console.log('');
}

if (missingTestConfig.length || missingTestScript.length) {
  console.log('FAILED — a workspace is missing its test-program type-check (its test/ tree would get zero type-checking):\n');
  for (const w of missingTestConfig) console.log(`    - ${w}: no tsconfig.test.json (copy a sibling's; it extends tsconfig.json and adds test/** to the program)`);
  for (const w of missingTestScript) console.log(`    - ${w}: no "typecheck:test" script (add \`"typecheck:test": "tsc --noEmit -p tsconfig.test.json"\`)`);
  if (missingFromSolution.length === 0 && extraInSolution.length === 0) process.exit(1);
  console.log('');
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
