// ─────────────────────────────────────────────────────────────────────────────
// B-track runner — SLG home-city build/train pacing (SLG_ECONOMY_CHECK §4).
//   npx tsx src/cityRun.ts
// Prints the code-derived totals + growth deltas + assumption-driven days-to-max.
// ─────────────────────────────────────────────────────────────────────────────

import {
  cityTotals, costByBuilding, maxLevelEffects, armyPacing,
  INCOME_PROFILES, hourlyIncome, daysToMax, daysToMaxWithWhaleSpend, whaleResourcePackDailyMax,
  type CityTotals,
} from './city';
import { RESOURCE_CAP, TROOP_CAP_BASE, DESK_MAX_LEVEL } from '@nw/shared';

const RES = ['ink', 'paper', 'graphite', 'metal', 'sticker'] as const;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '∞');

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }

bar('SLG home-city pacing — B-track intra-season check (SLG_ECONOMY_CHECK §4)');
console.log('Pure intra-season pacing: NOTHING here enters the §6.1 monthly coin budget.\n');

const totals: CityTotals = cityTotals();

console.log(`── 1. Cost to max ALL P1 buildings to L${DESK_MAX_LEVEL} (code-derived, no assumptions) ──`);
const byB = costByBuilding();
const header = 'building'.padEnd(13) + RES.map((r) => r.padStart(10)).join('');
console.log(header);
for (const [key, c] of Object.entries(byB)) {
  console.log(key.padEnd(13) + RES.map((r) => fmt((c as any)[r] ?? 0).padStart(10)).join(''));
}
console.log('-'.repeat(63));
console.log('TOTAL'.padEnd(13) + RES.map((r) => fmt((totals.cost as any)[r] ?? 0).padStart(10)).join(''));
console.log('xCAP'.padEnd(13) + RES.map((r) => (((totals.cost as any)[r] ?? 0) / RESOURCE_CAP).toFixed(1).padStart(10)).join(''));
console.log(`  RESOURCE_CAP = ${fmt(RESOURCE_CAP)} per resource. "xCAP" = total cost / cap`);
console.log('  -> any xCAP >> 1 means the resource MUST be earned over time, cannot be banked.\n');

console.log('── 2. Build TIME (serial, queue=1) + coin-to-skip ──');
console.log(`  serial build time to max all = ${f1(totals.serialBuildSec / 3600)} h = ${f1(totals.serialBuildSec / 86400)} days`);
console.log(`  coins to skip ALL build time = ${fmt(totals.coinsToSkipAll)} coins  (BUILD_SPEEDUP_SECS_PER_COIN)\n`);

console.log('── 3. Growth deltas at max level (multiplier sanity) ──');
const e = maxLevelEffects();
console.log(`  resource yield mult  : 1.00x -> ${e.yieldMultAtMax.toFixed(2)}x   (BUILD_YIELD_STEP)`);
console.log(`  storage cap          : ${fmt(e.capBase)} -> ${fmt(e.capAtMax)}   (CABINET_CAP_STEP)`);
console.log(`  troop cap            : ${fmt(e.troopCapBase)} -> ${fmt(e.troopCapAtMax)}   (DRILL_TROOPCAP_STEP)`);
console.log(`  train-time mult      : 1.00x -> ${e.trainMultAtMax.toFixed(2)}x (floored; floor bites at drillYard L${e.trainFloorBitesAtLevel})`);
console.log(`  training queue slots : -> ${e.queueAtMax}`);
console.log(`  sticker faucet @max  : ${fmt(e.stickerFaucetAtMax)}/h (stickerShop) + ${fmt(e.copperTileYield)}/h per held copper mine tile (map, ≥6)\n`);

console.log('── 4. Days-to-max per resource by income profile (ASSUMPTION-driven) ──');
console.log('   tile holdings are not pinned in design; profiles are explicit guesses, like A-track population.');
console.log('income'.padEnd(11) + RES.map((r) => r.padStart(10)).join('') + '   (days)');
for (const p of INCOME_PROFILES) {
  const d = daysToMax(p, totals);
  console.log(p.label.padEnd(11) + RES.map((r) => f1((d as any)[r] ?? 0).padStart(10)).join(''));
}
console.log('  hourly income used (per profile):');
for (const p of INCOME_PROFILES) {
  const inc = hourlyIncome(p);
  console.log('  ' + p.label.padEnd(9) + RES.map((r) => (fmt((inc as any)[r] ?? 0) + '/h').padStart(12)).join(''));
}
console.log('');

console.log('── 4b. F2P vs daily-capped whale spend (2026-07-15, SLG_DESIGN §7.2 purchase caps) ──');
const whale = whaleResourcePackDailyMax();
console.log(`  max resource-pack spend/day = ${fmt(whale.coinsPerDay)} coins -> +${fmt(whale.extraPerResourcePerDay)} to EVERY resource/day (stacked on free income)`);
console.log('  days-to-max per resource, free vs +daily-capped whale spend:');
console.log('income'.padEnd(11) + RES.map((r) => r.padStart(10)).join('') + '   (days, free -> +whale)');
for (const p of INCOME_PROFILES) {
  const free = daysToMax(p, totals);
  const whaled = daysToMaxWithWhaleSpend(p, totals);
  console.log(p.label.padEnd(11) + RES.map((r) => `${f1((free as any)[r] ?? 0)}->${f1((whaled as any)[r] ?? 0)}`.padStart(10)).join(''));
}
console.log('  NOTE: does not cover speedupTraining / build-time coin-skip (BUILD_SPEEDUP_SECS_PER_COIN) — those');
console.log('  convert coins directly to time with NO purchase-count cap, only bounded by how many coins a player');
console.log('  has. That remains an open gap (ECONOMY_NUMBERS §13-SLG.6), not fixed in this pass.\n');

console.log('── 5. Army training pacing (drillYard-max troop cap) ──');
const a = armyPacing();
console.log(`  troopCap @ drillYard L${DESK_MAX_LEVEL} = ${fmt(a.troopCap)} (base ${fmt(TROOP_CAP_BASE)})`);
console.log(`  fill it: ${fmt(a.inkToFill)} ink, ${f1(a.totalTrainHours)} h continuous, or skip for ${fmt(a.coinsToSkip)} coins`);
console.log(`  season window = ${a.seasonDays} days\n`);

bar('VERDICT');
console.log('See ECONOMY_VERIFICATION_LOG.md §13-SLG-CITY for the registered conclusion.');
