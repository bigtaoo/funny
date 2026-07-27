// ─────────────────────────────────────────────────────────────────────────────
// March-fatigue gradient runner (ADR-047 sanity check post ADR-049 map enlargement, 2026-07-27).
//   npx tsx src/marchFatigueRun.ts
// See marchFatigue.ts header for the question being answered (and for why "neighbor-province"/
// "hegemony-rush" turned out not to be valid single-leg quantities to sample).
// ─────────────────────────────────────────────────────────────────────────────

import { sampleWorld, summarize, MARCH_MORALE_MAX, MARCH_MORALE_COMBAT_FLOOR, HALF_DIAGONAL, FLOOR_TILES, type MarchSample } from './marchFatigue';

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const SEEDS = Array.from({ length: 10 }, (_, i) => i * 104729 + 3);
const SAMPLES_PER_CATEGORY = 4;

bar('SLG march-fatigue gradient check (ADR-052 ratio-based budget, post ADR-047/ADR-049)');
console.log(`MARCH_MORALE_MAX=${MARCH_MORALE_MAX} points, floor multiplier=${MARCH_MORALE_COMBAT_FLOOR}`);
console.log(`map half-diagonal = ${HALF_DIAGONAL.toFixed(0)} tiles → floor at ${FLOOR_TILES.toFixed(0)} tiles = ${pct(FLOOR_TILES / HALF_DIAGONAL)} of the map's full reach (ADR-052 ratio)\n`);

const all: MarchSample[] = [];
let randomPairAttempted = 0;
let randomPairReachable = 0;
for (const seed of SEEDS) {
  const t0 = Date.now();
  const { samples, randomPairAttempted: a, randomPairReachable: r } = sampleWorld(seed, SAMPLES_PER_CATEGORY);
  all.push(...samples);
  randomPairAttempted += a;
  randomPairReachable += r;
  console.log(`  seed ${seed}: ${samples.length} samples in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const rows = summarize(all);

console.log(`\ncategory              n   median-tiles  median-mult  %-at-floor(≥${FLOOR_TILES.toFixed(0)} tiles)`);
console.log('─'.repeat(78));
for (const r of rows) {
  console.log(
    `${r.category.padEnd(22)} ${String(r.n).padStart(3)}  ${String(r.medianTiles).padStart(12)}  ` +
    `${r.medianMult.toFixed(3).padStart(11)}  ${pct(r.pctAtFloor).padStart(6)}`,
  );
}

console.log(`\nrandom-pair single-leg reachability: ${randomPairReachable}/${randomPairAttempted} (${pct(randomPairReachable / randomPairAttempted)})`
  + ` — most uniform-random long-distance pairs are UNREACHABLE in one leg by design (ADR-034 crossing chokepoints), not a bug.`);

console.log('\n── verdict ──');
const home = rows.find((r) => r.category === 'home')!;
const intra = rows.find((r) => r.category === 'intra-province-far')!;

console.log(`  home (short local marches):        ${pct(home.pctAtFloor)} hit the floor — expected near-0%, this is the "no penalty near home" case.`);
console.log(`  intra-province-far (longest legal single-leg march within your own province): ${pct(intra.pctAtFloor)} hit the floor, median tiles=${intra.medianTiles}.`);

const homeFail = home.pctAtFloor > 0.2;
const gradientDead = intra.pctAtFloor >= 0.8;
console.log(`\n  [${homeFail ? 'FAIL' : 'PASS'}] home floor rate ${pct(home.pctAtFloor)} vs ≤20% ceiling (SLG_ECONOMY_CHECK §5.5).`);
console.log(`  [${gradientDead ? 'FAIL' : 'PASS'}] ${gradientDead ? 'the gradient is effectively dead for ordinary same-province marches' : 'a real gradient still exists for same-province marches'}`
  + ` — intra-province-far floor rate ${pct(intra.pctAtFloor)} vs ≤80% ceiling (SLG_ECONOMY_CHECK §5.5).`);

console.log('\nRegister conclusions → ECONOMY_VERIFICATION_LOG.md (new §13-SLG-MARCH)');
