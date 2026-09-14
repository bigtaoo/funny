#!/usr/bin/env node
// CI GATE (2026-09-14): fails the job if a source file ADDED by this change landed inside a measured
// coverage scope with zero of its executable lines ever run.
//
// Runs in the `coverage-report` job next to checkCoverageThreshold.mjs, over the same downloaded
// coverage/ artifacts and the same package lists (coverageLib.mjs). Separate script, separate exit
// code, for the same reason those two are separate from coverageSummary.mjs: "the package percentage
// is below the bar" and "this new file has no tests at all" are different failures with different
// fixes, and one message that could mean either is a message nobody acts on.
//
// ── Why a second gate at all ──────────────────────────────────────────────────────────────────────
//
// checkCoverageThreshold measures ONE number per package, and that grain cannot see a new file.
// Measured on 2026-09-14: `client/src/scenes/worldmap/logic/siegeHold.ts` shipped on 09-12 with the
// siege feature, was inside the gate from the moment it landed (its include entry is directory-level,
// `src/scenes/worldmap/logic/**`, so nobody had to remember anything), and had NO test anywhere for
// two days. Seven uncovered lines against client's 99.66% moved the gated number by 0.02pp — against
// a 90% bar. The same day, `server/commercial/src/iap.ts`'s `createAppleSubscriptionReader` was at
// zero calls in any test, wired only from a process entry point. Neither is a percentage problem, and
// no percentage bar that a healthy repo could pass would have caught either.
//
// A file is checked here if and only if the package already MEASURES it — i.e. it appears in that
// package's own coverage output. That is deliberate and it is also this gate's only escape hatch:
// a new file that genuinely should not be tested belongs outside its package's `coverage.include`,
// which is a visible, reviewed, one-line decision in a vitest config. There is no allowlist here and
// there must not be one — ADR-070 Phase 4e retired this repo's last coverage exemption mechanism on
// the reasoning that a working way to be exempt is a standing invitation to reach for it.
//
// ── What counts as "no tests at all" ──────────────────────────────────────────────────────────────
//
// `lines.covered === 0` while `lines.total > 0`. Not a percentage: one executed line is enough to
// pass, because the claim this gate makes is only "somebody wrote a test that reaches this file",
// and anything stricter is the percentage bar's job. `lines.total === 0` is skipped outright — a
// types-only module (`worldsvc/src/combatMarch/arrivalCtx.ts`, `metaserver/src/commercialClient/
// views.ts`) reports 0/0 and is not a gap; failing those would teach people to add a pointless test.
//
// Renames are not additions: `--diff-filter=A` with git's default rename detection reports a moved
// file as R, so moving a covered file does not trip this. If a move really does lose its coverage,
// that is a percentage drop and checkCoverageThreshold owns it.
//
// Usage: node scripts/checkNewFileCoverage.mjs   (cwd = repo root; same as the other two)
//   NEW_FILE_BASE_REF   what to diff against — the PR base sha, or `github.event.before` on a push.
//                       Empty, all-zeros (a branch's first push) or unresolvable falls back to
//                       `origin/main`; if THAT cannot be resolved either, this exits 1 rather than
//                       silently checking nothing. "Measured nothing" must never read as "nothing
//                       wrong" — the same rule as checkFileLength's and checkCoverageThreshold's
//                       own canaries.
//   TESTS_OK            'false' when a test job in this run already failed: report and exit 0, since
//                       the coverage artifacts are then partial by cause, the run is already red, and
//                       a second louder red buries the first (see checkCoverageThreshold's note).
import { spawnSync } from 'node:child_process';
import { JSON_SUMMARY_PACKAGES, LCOV_PACKAGES, readFileCoverage } from './coverageLib.mjs';

const PACKAGES = [...JSON_SUMMARY_PACKAGES, ...LCOV_PACKAGES];
const ZERO_SHA = /^0{7,40}$/;

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** First of the candidate refs that git can actually resolve, or null. */
function resolveBase(candidates) {
  for (const ref of candidates) {
    if (!ref || ZERO_SHA.test(ref)) continue;
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) return ref;
  }
  return null;
}

const base = resolveBase([process.env.NEW_FILE_BASE_REF, 'origin/main', 'main']);
if (!base) {
  console.error(
    'checkNewFileCoverage: FAILED — could not resolve any base ref to diff against (tried ' +
      'NEW_FILE_BASE_REF, origin/main, main). Without one this script checks nothing, and a gate ' +
      'that checks nothing must not report success. On CI this usually means the checkout was ' +
      'shallow: coverage-report needs fetch-depth: 0.',
  );
  process.exit(1);
}

// Canary, same shape as checkCoverageThreshold's: every lookup below iterates this list, so an
// emptied one would report a cheerful "0 added files to check" on any diff at all.
if (PACKAGES.length === 0) {
  console.error(
    'checkNewFileCoverage: FAILED — 0 packages to check. coverageLib.mjs\'s package lists are ' +
      'empty, or this was not run from the repo root.',
  );
  process.exit(1);
}

const diff = git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]);
if (!diff.ok) {
  console.error(`checkNewFileCoverage: FAILED — git diff against ${base} failed: ${diff.err}`);
  process.exit(1);
}
const added = diff.out ? diff.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];

// Per-file coverage for every gated package. `null` = that package emitted no artifact at all, which
// checkCoverageThreshold already fails on; this gate stays quiet about those files rather than
// reporting one broken step twice.
const measured = new Map(); // repoPath -> { pkg, total, covered }
const noCoverage = [];
for (const pkg of PACKAGES) {
  const rows = readFileCoverage(process.cwd(), pkg);
  if (rows === null) { noCoverage.push(pkg); continue; }
  for (const [path, counts] of rows) measured.set(path, { pkg, ...counts });
}

/** A test file is never measured ground, so listing it as "outside every scope" is pure noise —
 *  and noise in the out-of-scope line is what would hide the one case that line exists to make
 *  visible (a broken path mapping dumping real source files into it). */
const IS_TEST = (p) => /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec|ui|e2e|manual)\.tsx?$/.test(p);

const uncovered = [];
const typesOnly = [];
const deferred = [];
const deferredPkgs = new Set();
const outOfScope = [];
let placed = 0;
for (const path of added) {
  const row = measured.get(path);
  if (row) {
    placed++;
    if (row.total === 0) typesOnly.push(path);
    else if (row.covered === 0) uncovered.push({ path, pkg: row.pkg, total: row.total });
    continue;
  }
  const pending = noCoverage.find((pkg) => path.startsWith(`${pkg}/`));
  if (pending !== undefined) { deferred.push(path); deferredPkgs.add(pending); }
  else if (/\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !IS_TEST(path)) outOfScope.push(path);
}

const testsOk = process.env.TESTS_OK !== 'false';

if (!testsOk) {
  console.log(
    `checkNewFileCoverage: not enforced — a test job in this run failed, so the coverage artifacts ` +
      `are partial by cause. ${added.length} added file(s), ${uncovered.length} of them currently ` +
      'reading as untested; fix the failing job first.',
  );
  process.exit(0);
}

if (deferred.length > 0) {
  console.log(
    `checkNewFileCoverage: ${deferred.length} added file(s) are in packages that produced no ` +
      `coverage output (${[...deferredPkgs].join(', ')}) — checkCoverageThreshold owns that failure.`,
  );
}
// Not a failure: a file outside its package's `coverage.include` is this gate's documented escape
// hatch. It is printed because the realistic way this gate rots is that the path mapping breaks and
// EVERYTHING silently lands here, which looks identical to a green run unless the count is visible.
if (outOfScope.length > 0) {
  console.log(
    `checkNewFileCoverage: ${outOfScope.length} added .ts file(s) are outside every package's ` +
      `measured scope, so nothing is claimed about them — ${outOfScope.join(', ')}`,
  );
  if (placed === 0) {
    console.log(
      'checkNewFileCoverage: NOTE — none of the added files could be placed in a coverage scope. ' +
        'That is normal for a change that only touches unmeasured ground, and it is also exactly ' +
        'what a broken path mapping looks like. If you did add a file under a measured src/, check ' +
        'coverageEntryToRepoPath in scripts/coverageLib.mjs before trusting this green.',
    );
  }
}

if (uncovered.length > 0) {
  console.error(
    `checkNewFileCoverage: FAILED — ${uncovered.length} newly added source file(s) have ZERO ` +
      'covered lines, inside a scope their package already measures:\n' +
      uncovered.map((u) => `  • ${u.path}  (${u.total} executable lines, 0 covered)`).join('\n') +
      '\nEither add a test that reaches each one, or — if it genuinely should not be tested — take ' +
      "it out of that package's coverage.include, which is a visible decision in a vitest config.",
  );
  process.exit(1);
}

console.log(
  added.length === 0
    ? `checkNewFileCoverage: OK — no files added against ${base}.`
    : `checkNewFileCoverage: OK — ${placed} of ${added.length} added file(s) are in a measured ` +
        `scope, none at zero coverage${typesOnly.length > 0 ? ` (${typesOnly.length} with no executable lines, skipped)` : ''}.`,
);
