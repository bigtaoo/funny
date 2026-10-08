#!/usr/bin/env node
// Rebuilds one package's coverage/coverage-summary.json from the coverage of its CI test shards.
//
// Why this exists: metaserver and worldsvc run `fileParallelism: false` (one shared mongod per run),
// which made each of them the long pole of CI (685 s / 553 s of tests on 2026-10-08, against ~240 s
// for the next-slowest client step). ci.yml now splits each into two `vitest --shard=i/2` runners.
// A shard's own json-summary only describes the half of the suite it ran, so neither half can be
// held to the 90% bar — but each shard also writes coverage-final.json (raw hit counts per
// statement/function/branch, the `json` reporter in the package's vitest.config.ts), and those
// merge exactly: istanbul's FileCoverage.merge aligns entries by source location and sums the hits.
// That is the same library and the same reporter vitest itself used to write the unsharded
// summary, so coverageLib.mjs and every gate downstream read a file of the shape they always did.
//
// How exact (measured 2026-10-08 on metaserver, full run vs shard 1 + shard 2 merged): lines,
// statements and functions came out identical, total and per file (9218/10110 lines). Branches did
// not: 4512/4594 unsharded vs 4555/4620 merged (98.21% vs 98.59%). That is v8, not this script —
// a v8 branch map only lists the blocks of functions that actually ran, vitest unions the raw v8
// ranges before converting once, and here each shard is converted on its own and the istanbul maps
// are unioned by location, which keeps a few block splits the raw-level merge folds together. The
// line gate (and the per-file new-file gate, which reads lines) is therefore exact; the branch
// figure reads a few tenths high, which is why this PR's first run shows a small positive branch Δ.
//
// The istanbul packages are not this repo's direct dependencies; they come from server/'s lockfile
// as @vitest/coverage-v8's own dependencies, which is what makes the result match vitest's. If a
// vitest upgrade ever drops one, the require below fails loudly — it never falls back to guessing.
//
// A missing shard is NOT papered over: if any shard dir lacks coverage-final.json, nothing is
// written and the script exits 0 with a warning. The package then has no summary, which the
// coverage gate already reports as "produced no coverage" — a half-merged summary would instead
// read as a plausible, wrong percentage.
//
// Usage (cwd = repo root, after `npm ci` in server/):
//   node scripts/mergeCoverageShards.mjs <outDir> <shardDir> [<shardDir> ...]
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [outDir, ...shardDirs] = process.argv.slice(2);
if (!outDir || shardDirs.length === 0) {
  console.error('usage: node scripts/mergeCoverageShards.mjs <outDir> <shardDir> [<shardDir> ...]');
  process.exit(2);
}

const absent = shardDirs.filter((d) => !existsSync(join(d, 'coverage-final.json')));
if (absent.length > 0) {
  console.log(`::warning::mergeCoverageShards: no coverage-final.json in ${absent.join(', ')} — not writing ${outDir}/coverage-summary.json`);
  process.exit(0);
}

const require = createRequire(resolve('server', 'package.json'));
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const map = libCoverage.createCoverageMap({});
for (const dir of shardDirs) map.merge(JSON.parse(readFileSync(join(dir, 'coverage-final.json'), 'utf8')));

mkdirSync(outDir, { recursive: true });
const context = libReport.createContext({ dir: outDir, coverageMap: map });
reports.create('json-summary').execute(context);

const t = map.getCoverageSummary();
console.log(
  `mergeCoverageShards: ${shardDirs.length} shards, ${map.files().length} files -> ${outDir}/coverage-summary.json ` +
    `(lines ${t.lines.pct}%, branches ${t.branches.pct}%)`,
);
