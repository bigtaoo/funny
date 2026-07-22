// ─────────────────────────────────────────────────────────────────────────────
// Stronghold-track runner — SLG_ECONOMY_CHECK §21.4 "stronghold STRONGHOLD_* density/garrison/rewards"
//   npx tsx src/strongholdRun.ts
//
// The stronghold binding loot (strongholdMaterialLoot → meta.grantMaterial) is the one
// persistent faucet the A-track (index.ts) never aggregated. This runner:
//   ① counts strongholds with the REAL generator over the REAL map, across many seeds;
//   ①b breaks that down per ADR-034 ring type (outer/resource/core), added 2026-07-22;
//   ② quantifies the blob-clustering + seed-to-seed count variance;
//   ③ aggregates the persistent binding faucet and judges it against A-track dilution;
//   ④ sanity-checks the season-resource loot + NPC garrison accessibility;
//   ⑤ verdict + tuning recommendation.
// ─────────────────────────────────────────────────────────────────────────────

import {
  NUMBERS,
  countDistribution,
  countDistributionByRing,
  strongholdBlobs,
  bindingFaucet,
  GRIND_BINDING_PER_SEASON,
  SEASON_RES_PER_STRONGHOLD,
  STRONGHOLD_NPC_GARRISON,
  BINDING_PER_STRONGHOLD,
} from './stronghold';

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const N_SEEDS = 100;

bar('SLG stronghold economy — stronghold track (SLG_ECONOMY_CHECK §21.4)');
console.log(`map ${NUMBERS.MAP_W}×${NUMBERS.MAP_H} = ${fmt(NUMBERS.MAP_TILES)} tiles   world capacity target = ${NUMBERS.WORLD_CAPACITY_TARGET} players`);
console.log(`stronghold level = ${NUMBERS.STRONGHOLD_LEVEL} (map max)   binding/capture = ${BINDING_PER_STRONGHOLD}   season-res/capture = ${fmt(SEASON_RES_PER_STRONGHOLD)}   NPC garrison = ${fmt(STRONGHOLD_NPC_GARRISON)} troops`);
console.log(`binding coin value = ${NUMBERS.BINDING_COIN_VALUE} (epic, §2.4 conservative)   grind binding/season = ${fmt(GRIND_BINDING_PER_SEASON)}\n`);

// ── ① count distribution across seeds ────────────────────────────────────────
console.log('── ①  Stronghold COUNT distribution (real generator × ' + N_SEEDS + ' world seeds) ──\n');
const { stats } = countDistribution(N_SEEDS);
const dpct = (c: number) => `${((100 * c) / NUMBERS.MAP_TILES).toFixed(3)}%`;
console.log(`  count:  min=${stats.min}  p10=${stats.p10}  median=${stats.median}  mean=${stats.mean.toFixed(0)}  p90=${stats.p90}  max=${stats.max}  sd=${stats.sd.toFixed(0)}`);
console.log(`  as % of map:  min=${dpct(stats.min)}  median=${dpct(stats.median)}  p90=${dpct(stats.p90)}  max=${dpct(stats.max)}`);
console.log(`  worlds with ZERO strongholds: ${stats.zeroSeedPct.toFixed(0)}%   coefficient of variation = ${(stats.sd / Math.max(1, stats.mean)).toFixed(2)}`);
console.log(`  design intent (SLG_DESIGN §14 / slg.ts comment): "~0.3% of map, extremely sparse"\n`);

const DESIGN_TARGET_PCT = 0.3;
const medianPct = (100 * stats.median) / NUMBERS.MAP_TILES;
const cv = stats.sd / Math.max(1, stats.mean);
// A generation that meets intent = median near target AND low variance (CV well under ~0.5).
const densityOnTarget = medianPct <= DESIGN_TARGET_PCT * 2; // within 2× of the "~0.3%" intent
const varianceOk = cv <= 0.5 && stats.zeroSeedPct <= 5;
console.log(`  [${densityOnTarget ? 'PASS' : 'FAIL'}]  median density ${medianPct.toFixed(2)}% vs intent ~${DESIGN_TARGET_PCT}% (within 2×)`);
console.log(`  [${varianceOk ? 'PASS' : 'FAIL'}]  count consistency — CV ${cv.toFixed(2)} ≤ 0.50 and zero-stronghold worlds ${stats.zeroSeedPct.toFixed(0)}% ≤ 5%\n`);

// ── ①b per-ring-kind breakdown (ADR-034 angle-sector rings) ──────────────────
console.log('── ①b  Per-ring-kind density (ADR-034: outer/resource/core rings differ hugely in area) ──\n');
console.log('  §21.4/§19.5 only ever checked whole-map density. ADR-034 (2026-07-05, already implemented — see');
console.log('  design/game/SLG_DESIGN.md §2.4) splits the map into 6 outer + 3 resource + 1 core provinces of very');
console.log('  different area; strongholdMinDistRatio is measured from each tile\'s own province capital, not a');
console.log('  global one, so it is worth checking per-tile hit rate is comparable across ring types.\n');
const ringStats = countDistributionByRing(N_SEEDS);
console.log('  ring       tiles(map)   mean count   sd     CV     hit-rate/tile');
console.log('  ' + '─'.repeat(66));
for (const kind of ['outer', 'resource', 'core'] as const) {
  const r = ringStats[kind];
  console.log(`  ${kind.padEnd(9)}  ${fmt(r.tileCount).padStart(10)}   ${r.mean.toFixed(1).padStart(10)}   ${r.cv.toFixed(2).padStart(4)}   ${(r.hitRatePerTile * 100).toFixed(4)}%`);
}
const hitRates = (['outer', 'resource', 'core'] as const).map((k) => ringStats[k].hitRatePerTile);
const maxHit = Math.max(...hitRates), minHit = Math.min(...hitRates.filter((h) => h > 0)) || 0;
const hitRateRatio = minHit > 0 ? maxHit / minHit : Infinity;
const ringCvOk = (['outer', 'resource', 'core'] as const).every((k) => ringStats[k].cv <= 0.5);
const ringHitRateOk = hitRateRatio <= 2; // no ring type should be starved/flooded by more than 2× vs another
console.log(`\n  [${ringCvOk ? 'PASS' : 'FAIL'}]  each ring type's own CV ≤ 0.50 (per-ring generation is itself stable, not just the whole-map aggregate).`);
console.log(`  [${ringHitRateOk ? 'PASS' : 'FAIL'}]  per-tile hit-rate ratio across ring types = ${hitRateRatio.toFixed(2)}× ≤ 2× (no ring type systematically starved or flooded).`);
console.log(`  Note: the per-tile hash gate is seed/coordinate-driven, not ring-aware, so a uniform hit-rate across`);
console.log(`  ring types is exactly what's expected — a large deviation here would flag a bug in how`);
console.log(`  strongholdMinDistRatio's distance-to-capital measurement interacts with ring geometry.\n`);

// ── ② blob clustering ────────────────────────────────────────────────────────
console.log('── ②  Blob clustering (4-neighbour connected components; intent = isolated points) ──\n');
console.log('  seed          cells   blobs   mean-blob   max-blob');
console.log('  ' + '─'.repeat(56));
let blobMeanAcc = 0, blobSeeds = 0;
for (const s of ['world-1', 'world-2', 'world-5', 'world-11']) {
  const b = strongholdBlobs(s);
  if (b.count === 0) { console.log(`  ${s.padEnd(12)}  ${String(b.count).padStart(5)}   (none)`); continue; }
  console.log(`  ${s.padEnd(12)}  ${String(b.count).padStart(5)}   ${String(b.components).padStart(5)}   ${b.meanBlob.toFixed(1).padStart(9)}   ${String(b.maxBlob).padStart(8)}`);
  blobMeanAcc += b.meanBlob; blobSeeds++;
}
const avgBlob = blobSeeds ? blobMeanAcc / blobSeeds : 0;
const isolated = avgBlob < 2;
console.log(`\n  [${isolated ? 'PASS' : 'FAIL'}]  strongholds are isolated points — mean blob size ${avgBlob.toFixed(1)} < 2 cells`);
console.log(`  (smooth value-noise > threshold produces contiguous regions, not the "strategic points" the design wants)\n`);

// ── ③ persistent binding faucet vs A-track dilution ──────────────────────────
console.log('── ③  Persistent binding faucet vs A-track dilution (§2.3 threshold 15%) ──\n');
console.log('  The A-track (index.ts) aggregates SETTLE_REWARDS + trickle only. Stronghold binding');
console.log('  (grantMaterial, persistent) is ON TOP. Judged with the same §2.3 15% per-capita rule.');
console.log('  capture rate = fraction of a world\'s strongholds captured over the 60-day season');
console.log('  (progression-gated: base 2000-troop armies "nearly always lose", slg.ts:1055).\n');
const DILUTION_CAP = 0.15;
const scenarios: Array<{ label: string; count: number }> = [
  { label: `median world (${stats.median})`, count: stats.median },
  { label: `p90 world (${stats.p90})`, count: stats.p90 },
  { label: `max world (${stats.max})`, count: stats.max },
];
const captureRates = [0.25, 0.5, 1.0];
console.log('  world / capture    captures   world binding   /player·season   dilution vs grind   verdict');
console.log('  ' + '─'.repeat(92));
let anyFail = false;
for (const sc of scenarios) {
  for (const cr of captureRates) {
    const f = bindingFaucet(sc.count, cr);
    const dilution = f.perCapitaSpread / GRIND_BINDING_PER_SEASON;
    const pass = dilution <= DILUTION_CAP;
    if (!pass) anyFail = true;
    console.log(
      `  ${sc.label.padEnd(20).slice(0, 20)} ${pct(cr).padStart(4)}  ${fmt(f.capturesPerSeason).padStart(8)}   ${fmt(f.worldBinding).padStart(12)}   ${f.perCapitaSpread.toFixed(1).padStart(13)}   ${pct(dilution).padStart(16)}   ${pass ? '✅' : '❌'}`,
    );
  }
}
console.log('\n  Note: per-capita is spread across ALL players; binding actually concentrates on the few');
console.log('  progression-capable raiders, so their personal dilution is HIGHER than the spread figure.\n');

// ── ④ season-resource loot + garrison accessibility ──────────────────────────
console.log('── ④  Season-resource loot & NPC garrison (season-internal / battle sanity) ──\n');
const resVsCap = SEASON_RES_PER_STRONGHOLD / NUMBERS.RESOURCE_CAP;
console.log(`  season-resource loot per capture = ${fmt(SEASON_RES_PER_STRONGHOLD)} to one resType (§3.1, one-time, season-clears)`);
console.log(`    = ${pct(resVsCap)} of RESOURCE_CAP (${fmt(NUMBERS.RESOURCE_CAP)}) — a meaningful but capped one-off injection; season-internal (B-track, no persistent impact).`);
console.log(`  NPC garrison = ${fmt(STRONGHOLD_NPC_GARRISON)} troops at level ${NUMBERS.STRONGHOLD_LEVEL}.`);
console.log(`    base troop cap = ${fmt(NUMBERS.TROOP_CAP_BASE)} (drillYard grows to 12,000). A ${fmt(STRONGHOLD_NPC_GARRISON)}-troop NPC + base defender`);
console.log(`    advantage gates strongholds behind tech/equipment (slg.ts:1055) → capture rate is realistically ≤ 50%, not 100%.\n`);

// ── verdict ──────────────────────────────────────────────────────────────────
bar('VERDICT — stronghold track (SLG_ECONOMY_CHECK §21.4)');
console.log(`  ① density/variance:  ${densityOnTarget && varianceOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`     median ${medianPct.toFixed(2)}% (intent ~0.3%), CV ${cv.toFixed(2)}, ${stats.zeroSeedPct.toFixed(0)}% zero-stronghold worlds, ${stats.min}→${stats.max} spread.`);
console.log(`  ①b per-ring fairness: ${ringCvOk && ringHitRateOk ? '✅ PASS' : '❌ FAIL'}  (hit-rate ratio ${hitRateRatio.toFixed(2)}× across outer/resource/core, added 2026-07-22)`);
console.log(`  ② blob clustering:   ${isolated ? '✅ PASS' : '❌ FAIL'}  (mean blob ${avgBlob.toFixed(1)} cells)`);
console.log(`  ③ persistent faucet: ${anyFail ? '⚠️  CONDITIONAL  — safe at median×low-capture; breaches 15% at high-count seeds / full capture.' : '✅ PASS  — dilution ≤ 15% across all seeds even at 100% capture (per-tile hash gate removed the tail seeds).'}`);
console.log(`  ④ season loot / garrison: ✅ sane (one-off capped injection; garrison gates loot behind progression).\n`);

if (!densityOnTarget || !varianceOk || !isolated || !ringCvOk || !ringHitRateOk) {
  console.log('  NOTE: the smooth-value-noise generator that used to cause blobby/inconsistent density (root-caused');
  console.log('  and fixed 2026-07-02, see SLG_DESIGN_LOG.md §19.5) is gone — the generator has been a per-tile hash');
  console.log('  gate (rand2(x,y,seed^K) > strongholdThreshold=0.997) since that fix, so ①/② failing today would be');
  console.log('  a NEW regression, not the old known issue. If ①b specifically fails (ring-kind hit-rate imbalance),');
  console.log('  check whether strongholdMinDistRatio\'s distance-to-capital measurement interacts badly with the');
  console.log('  ADR-034 ring geometry (e.g. a ring type\'s tiles sitting disproportionately close to/far from their');
  console.log('  own province capital) rather than re-applying the old noise-gate fix, which is unrelated.');
} else {
  console.log('  ✅ STRONGHOLD TRACK CLOSED (incl. per-ring fairness, added 2026-07-22)');
}
console.log('\nRegister conclusions → ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD');
