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

function synthesizeArmy(troops: number, role: 'attacker' | 'defender'): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  if (remaining <= 0) return [];
  const n = Math.ceil(remaining / HP_PER_UNIT);
  const army: GarrisonEntry[] = [];
  for (let i = 0; i < n; i++) {
    const hp = Math.min(HP_PER_UNIT, remaining);
    remaining -= hp;
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
function attackerWins(troops: number, garrison: number, tileLevel: number, baseHp: number, seed: number): boolean {
  const defenderConfig: Record<string, unknown> = { garrison: synthesizeArmy(garrison, 'defender') };
  if (baseHp > 0) defenderConfig.defenderBaseHp = baseHp;
  const levelObj = buildSiegeBattle({ army: synthesizeArmy(troops, 'attacker') }, defenderConfig, tileLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless({ seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level }, input, timeout + TICK_MARGIN);
  return engine.state.winner === Side.Bottom;
}

const SEEDS = [1, 2, 3, 4, 5];
function winsAll(troops: number, garrison: number, level: number, baseHp: number): boolean {
  return SEEDS.every((s) => attackerWins(troops, garrison, level, baseHp, s));
}

/** Smallest troop count (step 60 = one infantry) that wins every seed; caps the search to avoid board overflow. */
function minWinningTroops(garrison: number, level: number, baseHp: number): number | null {
  const CAP = 9600; // synthesizeArmy board capacity; beyond this lane congestion muddies results (see strongholdCombat.ts)
  for (let troops = HP_PER_UNIT; troops <= CAP; troops += HP_PER_UNIT) {
    if (winsAll(troops, garrison, level, baseHp)) return troops;
  }
  return null;
}

console.log('tile | garrison | base(old=100) minWin | base(new=40×L) minWin');
console.log('-----|----------|----------------------|----------------------');
for (let level = 1; level <= SLG_MAP_MAX_LEVEL; level++) {
  const g = npcGarrison(level);
  const oldMin = minWinningTroops(g, level, 100);          // flat 100 (pre-change)
  const newMin = minWinningTroops(g, level, npcBaseHp(level)); // 40×level (post-change)
  const fmt = (n: number | null) => (n === null ? '  >9600 (overflow)' : `${String(n).padStart(6)} (${Math.ceil(n / HP_PER_UNIT)} inf)`);
  console.log(
    `${String(level).padStart(4)} | ${String(g).padStart(8)} | ${fmt(oldMin).padStart(20)} | ${fmt(newMin).padStart(20)}  base=${npcBaseHp(level)}`,
  );
}
