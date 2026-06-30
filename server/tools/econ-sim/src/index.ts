// ─────────────────────────────────────────────────────────────────────────────
// SLG econ-sim runner (A-track of SLG_ECONOMY_CHECK).
//
//   npx tsx src/index.ts                     # runs conservative + baseline + aggressive
//   npx tsx src/index.ts scenarios/foo.json  # runs a specific scenario file
//
// Headless, imports @nw/shared constants, never connects to the DB. Counterpart of
// client/test/difficultySim.ts on the economy side.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import { MATERIALS } from './valuation';
import { MATERIAL_COIN_VALUE, REGULAR_MONTHLY_MATERIAL, REGULAR_MONTHLY_MATERIAL_COINS } from './valuation';
import { runScenario, judge, type Scenario, type SimResult, type Judgment } from './model';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function loadScenario(file: string): Scenario {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as Scenario;
}

function printValuationHeader(): void {
  console.log('═'.repeat(78));
  console.log('SLG econ-sim — A-track persistent-economy aggregation (SLG_ECONOMY_CHECK §2)');
  console.log('═'.repeat(78));
  console.log('Material -> coin valuation (conservative upper bound, derived from shipped constants):');
  for (const mat of MATERIALS) {
    console.log(`  ${mat.padEnd(8)} = ${MATERIAL_COIN_VALUE[mat].toFixed(2)} coins`);
  }
  console.log('Regular F2P grind baseline (per player, monthly):');
  for (const mat of MATERIALS) {
    console.log(`  ${mat.padEnd(8)} ${fmt(REGULAR_MONTHLY_MATERIAL[mat])}/mo`);
  }
  console.log(`  = ${fmt(REGULAR_MONTHLY_MATERIAL_COINS)} coin-eq/mo per player`);
  console.log('');
}

function printResult(r: SimResult): void {
  const s = r.scenario;
  console.log('─'.repeat(78));
  console.log(`SCENARIO: ${s.name}  (pop ${fmt(s.population)}, ${r.shardCount} shard(s), season ${s.seasonDays}d = ${r.seasonMonths.toFixed(1)}mo)`);
  if (s.note) console.log(`  ${s.note}`);
  console.log('');
  console.log('  Per-tier (per-head + server-wide):');
  console.log(
    '    ' +
      'tier'.padEnd(12) +
      'heads/srv'.padStart(11) +
      'perHead/season'.padStart(16) +
      'perHead/mo'.padStart(12) +
      'srv/season'.padStart(14),
  );
  for (const t of r.tiers) {
    console.log(
      '    ' +
        t.tier.padEnd(12) +
        fmt(t.headsServerWide).padStart(11) +
        (fmt(t.perHeadSeasonCoins) + 'c').padStart(16) +
        (fmt(t.perHeadMonthlyCoins) + 'c').padStart(12) +
        (fmt(t.serverWideSeasonCoins)).padStart(14),
    );
  }
  console.log('');
  console.log('  Server-wide season material (settle + 细水):');
  for (const mat of MATERIALS) {
    console.log(`    ${mat.padEnd(8)} ${fmt(r.serverWideMaterial[mat])}  (细水 part ${fmt(r.trickleMaterial[mat])})`);
  }
  console.log(`    Σ coin-eq = ${fmt(r.serverWideSeasonCoins)}/season = ${fmt(r.serverWideMonthlyCoins)}/mo`);
  console.log('');
  console.log('  Judgments (§2.3):');
  const judgments = judge(r);
  let allCorePass = true;
  for (const j of judgments) {
    const mark = j.pass ? 'PASS' : 'FAIL';
    // The coin-faucet cross-ref is informational, not a gate.
    const informational = j.key.includes('跨类参考');
    if (!j.pass && !informational) allCorePass = false;
    console.log(`    [${mark}]${informational ? '*' : ' '} ${j.key}`);
    console.log(`           ${j.detail}`);
    console.log(`           value ${typeof j.value === 'number' ? j.value.toFixed(3) : j.value}  threshold ${j.threshold}`);
  }
  console.log('');
  console.log(`  => CORE verdict (excl. *跨类参考 informational): ${allCorePass ? 'PASS' : 'FAIL'}`);
  console.log('');
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = path.resolve(__dirname, '..', 'scenarios');
  const files =
    args.length > 0 ? args : ['conservative.json', 'baseline.json', 'aggressive.json'].map((f) => path.join(dir, f));

  printValuationHeader();
  const results: { name: string; core: boolean }[] = [];
  for (const f of files) {
    const scenario = loadScenario(path.isAbsolute(f) ? f : path.resolve(process.cwd(), f));
    const r = runScenario(scenario);
    printResult(r);
    const judgments: Judgment[] = judge(r);
    const core = judgments.every((j) => j.pass || j.key.includes('跨类参考'));
    results.push({ name: scenario.name, core });
  }

  console.log('═'.repeat(78));
  console.log('SUMMARY (core verdict per scenario):');
  for (const x of results) console.log(`  ${x.name.padEnd(14)} ${x.core ? 'PASS' : 'FAIL'}`);
  console.log('  * = informational cross-reference, not a gate (see §13-SLG note)');
  console.log('═'.repeat(78));
}

main();
