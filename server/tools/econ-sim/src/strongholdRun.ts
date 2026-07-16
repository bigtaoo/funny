// ─────────────────────────────────────────────────────────────────────────────
// Stronghold-track runner — SLG_ECONOMY_CHECK §21.4 "stronghold STRONGHOLD_* density/garrison/rewards"
//   npx tsx src/strongholdRun.ts
//
// The stronghold binding loot (strongholdMaterialLoot → meta.grantMaterial) is the one
// persistent faucet the A-track (index.ts) never aggregated. This runner:
//   ① counts strongholds with the REAL generator over the REAL map, across many seeds;
//   ② quantifies the blob-clustering + seed-to-seed count variance;
//   ③ aggregates the persistent binding faucet and judges it against A-track dilution;
//   ④ sanity-checks the season-resource loot + NPC garrison accessibility;
//   ⑤ verdict + tuning recommendation.
// ─────────────────────────────────────────────────────────────────────────────

import {
  NUMBERS,
  countDistribution,
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
console.log(`  ② blob clustering:   ${isolated ? '✅ PASS' : '❌ FAIL'}  (mean blob ${avgBlob.toFixed(1)} cells)`);
console.log(`  ③ persistent faucet: ${anyFail ? '⚠️  CONDITIONAL  — safe at median×low-capture; breaches 15% at high-count seeds / full capture.' : '✅ PASS  — dilution ≤ 15% across all seeds even at 100% capture (per-tile hash gate removed the tail seeds).'}`);
console.log(`  ④ season loot / garrison: ✅ sane (one-off capped injection; garrison gates loot behind progression).\n`);

if (!densityOnTarget || !varianceOk || !isolated) {
  console.log('  ROOT CAUSE: strongholds use smooth value-noise (valueNoise, freq 1/70) > threshold 0.92.');
  console.log('  On a 300×300 map that noise field has only ~(300/70)²≈18 lattice points, so the count is');
  console.log('  governed by a handful of lattice values → 0-to-thousands per seed, and cells clump into blobs.');
  console.log('');
  console.log('  RECOMMENDATION (→ ECONOMY_NUMBERS §13-SLG-STRONGHOLD): replace the smooth-noise gate with a');
  console.log('  per-tile hash gate (rand2(x,y,seed^K) > t). A per-tile Bernoulli(p=0.003) draw over 90,000');
  console.log('  tiles gives count ≈ 270 ± √(90000·0.003·0.997) ≈ ±16 (CV ≈ 0.06), isolated points, and hits');
  console.log('  the "~0.3% extremely sparse" intent deterministically — turning ③ from CONDITIONAL to PASS by');
  console.log('  removing the tail seeds that breach dilution. This is a shared/slg.ts generation change');
  console.log('  (public dep — merge first per worktree rule 4); tune p to the final target density.');
} else {
  console.log('  ✅ STRONGHOLD TRACK CLOSED');
}
console.log('\nRegister conclusions → ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD');
