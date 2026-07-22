// One-off verification for the SLG option-2 base-HP change (2026-07-17): NPC-tile base HP now scales with tile
// level (npcBaseHp = 40×level) instead of a flat BASE_HP=100. Sweeps tile levels 1..10 and finds the minimal
// synthesized-infantry attacker troop count that reliably (100% over N seeds) captures the tile — under BOTH the
// old flat-100 base and the new 40×level base — so we can see the fix soften low-level tiles without making high
// tiles trivial. Answers the owner's original question: "每级地需要什么样子的配置才能打赢?".
//
// Run: npm run --workspace @nw/econ-sim occupy-base-hp   (or: npx tsx src/occupyBaseHpRun.ts)
import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  UnitType,
  Side,
  ATTACK_LANES,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
  parseLevelDefinition,
  type GarrisonEntry,
} from '@nw/engine';
import { buildSiegeBattle, npcGarrison, npcBaseHp, SLG_MAP_MAX_LEVEL } from '@nw/shared';

const HP_PER_UNIT = UNIT_BLUEPRINTS[UnitType.Infantry].hp;
const TICK_MARGIN = 600;

/**
 * `hpMult` simulates the post-cap hp scaling `buildSiegeBlueprints` applies for equipment/academy
 * bonuses (`unit.hp = round(hp * (1 + siegeAcademy.hp))`, see `server/engine/src/balance/pveUpgrades.ts`)
 * without actually constructing `cardInstances`/`equipmentInv` — this script synthesizes raw
 * `GarrisonEntry[]` armies and never goes through the blueprint pipeline, so the per-unit hp is
 * scaled directly here instead. Unit *count* is still derived from the baseline `HP_PER_UNIT` (i.e.
 * `troops` stays a population/manpower budget); `hpMult` scales each of those units' actual hp up,
 * which raises the army's total effective hp for the same troop count — mirroring what gear/academy
 * really do (stronger soldiers, not more of them).
 */
function synthesizeArmy(troops: number, role: 'attacker' | 'defender', hpMult = 0): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  if (remaining <= 0) return [];
  const n = Math.ceil(remaining / HP_PER_UNIT);
  const army: GarrisonEntry[] = [];
  for (let i = 0; i < n; i++) {
    const baseHp = Math.min(HP_PER_UNIT, remaining);
    remaining -= baseHp;
    const hp = Math.round(baseHp * (1 + hpMult));
    const col = ATTACK_LANES[i % ATTACK_LANES.length]!;
    const depth = Math.floor(i / ATTACK_LANES.length);
    const row = role === 'attacker'
      ? Math.min(TOP_SPAWN_ROW, BOTTOM_SPAWN_ROW + depth)
      : Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - depth);
    army.push({ unitType: UnitType.Infantry, col, row, initialHp: hp });
  }
  return army;
}

/** One siege. `baseHp>0` sets the defender base ceiling; baseHp=0 → engine default (flat BASE_HP=100). */
function attackerWins(troops: number, garrison: number, tileLevel: number, baseHp: number, seed: number, hpMult = 0): boolean {
  const defenderConfig: Record<string, unknown> = { garrison: synthesizeArmy(garrison, 'defender') };
  if (baseHp > 0) defenderConfig.defenderBaseHp = baseHp;
  const levelObj = buildSiegeBattle({ army: synthesizeArmy(troops, 'attacker', hpMult) }, defenderConfig, tileLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless({ seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level }, input, timeout + TICK_MARGIN);
  return engine.state.winner === Side.Bottom;
}

const SEEDS = [1, 2, 3, 4, 5];
function winsAll(troops: number, garrison: number, level: number, baseHp: number, hpMult = 0): boolean {
  return SEEDS.every((s) => attackerWins(troops, garrison, level, baseHp, s, hpMult));
}

/** Smallest troop count (step 60 = one infantry) that wins every seed; caps the search to avoid board overflow. */
function minWinningTroops(garrison: number, level: number, baseHp: number, hpMult = 0): number | null {
  const CAP = 9600; // synthesizeArmy board capacity; beyond this lane congestion muddies results (see strongholdCombat.ts)
  for (let troops = HP_PER_UNIT; troops <= CAP; troops += HP_PER_UNIT) {
    if (winsAll(troops, garrison, level, baseHp, hpMult)) return troops;
  }
  return null;
}

const fmt = (n: number | null) => (n === null ? '  >9600 (overflow)' : `${String(n).padStart(6)} (${Math.ceil(n / HP_PER_UNIT)} inf)`);

console.log('tile | garrison | base(old=100) minWin | base(new=40×L) minWin');
console.log('-----|----------|----------------------|----------------------');
for (let level = 1; level <= SLG_MAP_MAX_LEVEL; level++) {
  const g = npcGarrison(level);
  const oldMin = minWinningTroops(g, level, 100);          // flat 100 (pre-change)
  const newMin = minWinningTroops(g, level, npcBaseHp(level)); // 40×level (post-change)
  console.log(
    `${String(level).padStart(4)} | ${String(g).padStart(8)} | ${fmt(oldMin).padStart(20)} | ${fmt(newMin).padStart(20)}  base=${npcBaseHp(level)}`,
  );
}

// ── Equipment/academy hp stacking — does 40×level still hold once real players' gear scales attacker hp? ──
// Scenarios: 0% (baseline, no gear/academy — same as above), 10% (typical mid-game gear, no academy),
// 20% (gear + maxed academy siege-hp channel stacked — see ECONOMY_NUMBERS.md equipment tiers / SLG_CITY_DESIGN academy).
console.log('\n\nEquipment/academy hp-stacking check (base = 40×level, the post-2026-07-17 value):');
console.log('tile | garrison | base  | hpMult=0% minWin | hpMult=10% minWin | hpMult=20% minWin');
console.log('-----|----------|-------|-------------------|--------------------|-------------------');
const HP_MULTS = [0, 0.10, 0.20];
const rows: { level: number; mins: (number | null)[] }[] = [];
for (let level = 1; level <= SLG_MAP_MAX_LEVEL; level++) {
  const g = npcGarrison(level);
  const base = npcBaseHp(level);
  const mins = HP_MULTS.map((m) => minWinningTroops(g, level, base, m));
  rows.push({ level, mins });
  console.log(
    `${String(level).padStart(4)} | ${String(g).padStart(8)} | ${String(base).padStart(5)} | ${fmt(mins[0]!).padStart(19)} | ${fmt(mins[1]!).padStart(20)} | ${fmt(mins[2]!).padStart(19)}`,
  );
}

// ── Sensitivity check: the coarse sweep above steps `troops` in whole-unit (60hp) increments, which can
// mask a real but sub-unit shift in the win threshold. Test one unit BELOW the 0%-baseline threshold —
// if hp bonus is doing anything at all, some level should flip from loss→win there at 10%/20%.
console.log('\nSensitivity check — one unit below the 0% threshold, does hpMult flip loss→win?');
console.log('tile | troops (thresh-1unit) | hpMult=0% | hpMult=10% | hpMult=20%');
console.log('-----|------------------------|-----------|------------|-----------');
let anyFlip = false;
for (const { level, mins } of rows) {
  const baseline = mins[0];
  if (baseline == null || baseline <= HP_PER_UNIT) continue; // no room to go one unit lower
  const g = npcGarrison(level);
  const base = npcBaseHp(level);
  const troopsBelow = baseline - HP_PER_UNIT;
  const results = HP_MULTS.map((m) => winsAll(troopsBelow, g, level, base, m));
  if (results[1] || results[2]) anyFlip = true;
  console.log(
    `${String(level).padStart(4)} | ${String(troopsBelow).padStart(22)} | ${String(results[0]).padStart(9)} | ${String(results[1]).padStart(10)} | ${String(results[2]).padStart(9)}`,
  );
}
console.log(`  ${anyFlip ? 'Gear/academy hp DOES shift the win threshold (sub-unit effect masked by the coarse sweep above).' : 'Gear/academy hp bonus (up to +20%) makes NO measurable difference to minWinningTroops at any tested level — the coarse sweep\'s identical columns are real, not a granularity artifact.'}`);

console.log('\nVerdict:');
let monotonic = true;
for (const { level, mins } of rows) {
  if (level === 1) continue;
  const prev = rows[level - 2]!.mins;
  // Within each hpMult column, higher level should never need fewer troops than the level below it.
  for (let c = 0; c < HP_MULTS.length; c++) {
    if (mins[c] !== null && prev[c] !== null && mins[c]! < prev[c]!) monotonic = false;
  }
}
const anyOverflow = rows.some((r) => r.mins.some((m) => m === null));
console.log(`  [${monotonic ? 'PASS' : 'FAIL'}] minWinningTroops stays monotonically non-decreasing by level within every hpMult column.`);
console.log(`  [${anyOverflow ? 'FAIL' : 'PASS'}] no scenario/level combination overflows the 9600-troop board cap.`);
console.log(`  [INFO] gear/academy hp sensitivity: ${anyFlip ? 'measurable at sub-unit granularity' : 'no measurable effect on capture difficulty at these force ratios'}.`);
console.log(`  ${monotonic && !anyOverflow ? 'CLOSED' : 'NEEDS ATTENTION'} — register conclusion → design/game/ECONOMY_VERIFICATION_LOG.md + SLG_DESIGN_LOG.md §29.`);
