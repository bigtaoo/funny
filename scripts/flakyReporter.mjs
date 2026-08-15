// Vitest reporter that makes `retry: N` VISIBLE instead of silent (2026-08-15).
//
// The DB-backed e2e suites run with `retry: 1` (see each package's vitest.config.ts) so a single
// scheduler/driver hiccup can't turn a merged PR into a blocked deploy. A retry that silently
// repaints red as green would be strictly worse than no retry at all — it converts "this test is
// flaky" from a loud CI failure into invisible debt. So every test that FAILED and then passed on a
// later attempt is reported here:
//   • as a GitHub `::warning::` annotation (shows up inline on the run page),
//   • as a section in the job's step summary,
//   • as `flaky-report.json` in the package dir, which CI uploads as an artifact and the nightly
//     flake-hunt workflow aggregates.
// A test that fails every attempt is NOT reported here — it already fails the run normally.
//
// Wired as `reporters: ['default', new FlakyReporter()]`. Cheap and side-effect-free outside CI:
// with no flaky tests it prints nothing and writes no file.
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Depth-first walk over vitest's task tree, yielding leaf tests only. */
function* eachTest(tasks) {
  for (const task of tasks ?? []) {
    if (task.type === 'suite') yield* eachTest(task.tasks);
    else if (task.type === 'test' || task.type === 'custom') yield task;
  }
}

/** Full "describe > describe > it" path, matching how vitest itself prints a failing test. */
function fullName(task) {
  const parts = [];
  for (let node = task; node; node = node.suite) {
    // The file-level task is itself a suite whose `name` is the file path — stop there, the
    // path is reported separately.
    if (node.filepath) break;
    if (node.name) parts.unshift(node.name);
  }
  return parts.join(' > ');
}

export class FlakyReporter {
  constructor(label = process.env.NW_FLAKY_LABEL ?? path.basename(process.cwd())) {
    this.label = label;
  }

  onFinished(files = []) {
    const flaky = [];
    for (const file of files) {
      for (const task of eachTest(file.tasks)) {
        const result = task.result;
        // retryCount counts ATTEMPTS BEYOND THE FIRST that vitest had to make; > 0 with a final
        // pass is precisely "failed, then passed on a retry".
        if (!result || result.state !== 'pass') continue;
        const retries = result.retryCount ?? 0;
        if (retries > 0) {
          flaky.push({
            package: this.label,
            // Forward slashes even on Windows: this string ends up in a GitHub `file=` annotation.
            file: path.relative(process.cwd(), file.filepath ?? file.name ?? '').split(path.sep).join('/'),
            test: fullName(task),
            retries,
          });
        }
      }
    }
    if (flaky.length === 0) return;

    for (const f of flaky) {
      // GitHub annotation — visible on the run page without opening the log.
      console.log(`::warning file=${f.file}::FLAKY (passed after ${f.retries} retry): ${f.test}`);
    }
    const summary = [
      `### ⚠️ Flaky tests in \`${this.label}\` (passed only after a retry)`,
      '',
      '| Test | File | Retries |',
      '|---|---|---|',
      ...flaky.map((f) => `| ${f.test} | \`${f.file}\` | ${f.retries} |`),
      '',
      'These did NOT fail the run (retry masked them), but they are nondeterministic and must be fixed —',
      'see `claudedocs/server.md` "CI 稳定性" for the determinism rules and the two accepted fix patterns.',
      '',
    ].join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`); } catch { /* summary is best-effort */ }
    }
    try { writeFileSync(path.join(process.cwd(), 'flaky-report.json'), `${JSON.stringify(flaky, null, 2)}\n`); } catch { /* artifact is best-effort */ }
  }
}

export default FlakyReporter;
