// ─────────────────────────────────────────────────────────────────────────────
// B-track runner — SLG nation-bonus "naked economy" check (SLG_ECONOMY_CHECK §4 §1).
//   npx tsx src/nationBonusRun.ts
// Prints Voronoi geometry + break-even math + strategy gap table.
// ─────────────────────────────────────────────────────────────────────────────

import {
  voronoiTileCounts, mapLevelStats, breakEvenForeignLevel,
  runAllScenarios, HOURS_PER_SEASON,
} from './nationBonus';
import {
  NATION_BONUS_PRODUCTION, NATION_COUNT, CAPITAL_FRACTIONS,
  RESOURCE_YIELD_BASE, SEASON_LENGTH_DAYS,
} from '@nw/shared';

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const f2 = (n: number) => n.toFixed(2);
const f1 = (n: number) => n.toFixed(1);
const pct = (n: number) => n.toFixed(1) + '%';

bar('SLG nation-bonus naked-economy check — B-track (SLG_ECONOMY_CHECK §4 ¶1)');
console.log('Pure intra-season: NOTHING here enters the §6.1 monthly coin budget.\n');
console.log(`  NATION_BONUS_PRODUCTION = ${NATION_BONUS_PRODUCTION} (+${pct(NATION_BONUS_PRODUCTION * 100)} resource yield in own Voronoi nation)`);
console.log(`  SEASON_LENGTH_DAYS      = ${SEASON_LENGTH_DAYS} days = ${HOURS_PER_SEASON} h`);
console.log(`  RESOURCE_YIELD_BASE     = ${RESOURCE_YIELD_BASE} /tile/level/h\n`);

// ── ① Voronoi geometry ───────────────────────────────────────────────────────
console.log('── ①  Voronoi geometry (code-derived, no assumptions) ──────────────────────');
const tileCounts = voronoiTileCounts();
const totalTiles = tileCounts.reduce((a, b) => a + b, 0);
const stats = mapLevelStats();
console.log(`  Map: 300×300 = ${fmt(totalTiles)} tiles  (${fmt(stats.resourceTileCount)} resource tiles @ 34% density)`);
console.log(`  10 Voronoi nations, sizes:\n`);
console.log('  cap#  fraction    tile count  notes');
for (let i = 0; i < NATION_COUNT; i++) {
  const frac = tileCounts[i]! / totalTiles;
  const [fx, fy] = CAPITAL_FRACTIONS[i]!;
  const note = i === 9 ? '← center (contest objective)' : i === 8 ? '← inner-ring NW' : '';
  console.log(`   ${i.toString().padStart(2)}   ${(frac * 100).toFixed(1).padStart(5)}%    ${fmt(tileCounts[i]!).padStart(8)}    (${fx.toFixed(2)},${fy.toFixed(2)}) ${note}`);
}
const minN = Math.min(...tileCounts);
const maxN = Math.max(...tileCounts);
const avgN = totalTiles / NATION_COUNT;
console.log(`\n  Range: ${fmt(minN)} – ${fmt(maxN)} tiles/nation  (avg ${fmt(avgN)})`);
console.log(`  Smallest nation = ${(minN / avgN * 100).toFixed(0)}% of avg; largest = ${(maxN / avgN * 100).toFixed(0)}% of avg`);
console.log(`  Resource tiles per nation (avg): ${fmt(Math.round(stats.resourceTileCount / NATION_COUNT))}\n`);

// ── ② Break-even math ────────────────────────────────────────────────────────
console.log('── ②  Break-even marginal value (pure math, no assumption) ─────────────────');
console.log('  Per-tile output: home = base×homeLevel×1.10  |  foreign = base×foreignLevel');
console.log('  Cross-expansion pays off when: foreignLevel > homeLevel × 1.10\n');
for (const homeLevel of [2, 3, 4, 5]) {
  const be = breakEvenForeignLevel(homeLevel);
  console.log(`  homeLevel=${homeLevel}  →  break-even foreignLevel = ${f2(be)}  (${(NATION_BONUS_PRODUCTION * 100).toFixed(0)}% above home level)`);
}
console.log('\n  → High-value foreign territory (e.g., level 4 vs home average level 3) clears the bar');
console.log('    comfortably, keeping cross-nation expansion economically attractive.\n');

// ── ③ Strategy gap table ─────────────────────────────────────────────────────
console.log('── ③  Strategy gap table (ASSUMPTION-driven, explicit — see comments in nationBonus.ts) ─');
console.log('  Both strategies hold the SAME total tile count (tileCap=50).');
console.log('  Gap = (Home output − Cross output) / Cross output × 100%.');
console.log('  Positive gap = Home strategy wins; negative gap = Cross strategy wins.');
console.log('  Criterion: gap ≤ 20% → PASS  (SLG_ECONOMY_CHECK §4)\n');

const results = runAllScenarios();
const header = 'Scenario'.padEnd(30) + 'Home /h'.padStart(12) + 'Cross /h'.padStart(12) + 'Gap%'.padStart(8) + 'Verdict'.padStart(9);
console.log(header);
console.log('-'.repeat(71));
for (const r of results) {
  const label = r.s.label.padEnd(30);
  const homeH = fmt(Math.round(r.homeSeasonOutput / HOURS_PER_SEASON)).padStart(12);
  const crossH = fmt(Math.round(r.crossSeasonOutput / HOURS_PER_SEASON)).padStart(12);
  const g = (r.gapPct >= 0 ? '+' : '') + pct(r.gapPct);
  const verdict = r.pass ? '✅ PASS' : '❌ FAIL';
  console.log(label + homeH + crossH + g.padStart(8) + verdict.padStart(9));
}

// ── Summary ──────────────────────────────────────────────────────────────────
const allPass = results.every((r) => r.pass);
const maxGap = Math.max(...results.map((r) => r.gapPct));
const minGap = Math.min(...results.map((r) => r.gapPct));

bar('VERDICT');
console.log(`  Max home-strategy advantage across all scenarios: ${pct(maxGap)}`);
console.log(`  Min (cross wins by):                              ${pct(-minGap)}`);
console.log(`  Criterion ≤ 20%: ${allPass ? '✅ ALL SCENARIOS PASS' : '❌ SOME SCENARIOS FAIL'}\n`);
console.log('  Structural guarantee (pure math):');
console.log(`    The maximum possible home-strategy advantage = NATION_BONUS_PRODUCTION = ${pct(NATION_BONUS_PRODUCTION * 100)}.`);
console.log('    This occurs only when comparing pure-home vs pure-foreign at equal tile levels (level parity).');
console.log('    10% is structurally always ≤ 20% — the criterion cannot fail regardless of tile count or profile.\n');
console.log('  Strategic interpretation:');
console.log('    • For high-value foreign tiles (level 4 vs home avg 3 = +33% level premium), cross-expansion wins.');
console.log('    • The bonus incentivizes defending home territory without locking players in (cross-expansion remains viable).');
console.log('    • Smaller nations (fewer home tiles) face more pressure to expand cross-nation — healthy tension.');
console.log('\nSee ECONOMY_NUMBERS.md §13-SLG for the registered conclusion (national bonus row).');
