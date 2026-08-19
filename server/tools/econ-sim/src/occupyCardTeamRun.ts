// Empty-land (NPC tile) capture calibration for REAL 12-CARD TEAMS — the model that actually ships
// (ADR-069, 2026-08-19). Companion to, and corrective for, occupyBaseHpRun.ts.
//
// Why this file exists. occupyBaseHpRun.ts answers "每级地需要什么样子的配置才能打赢?" using a
// SYNTHESIZED infantry army: `synthesizeArmy(troops)` mints one 60-HP unit per 60 troops, so unit COUNT
// (and therefore Σ siegeValue, the only thing that can bring a base down) grows linearly with troops.
// Real play never looks like that: an occupy/attack march carries a card TEAM — at most
// CARD_TEAM_MAX_SIZE = 12 units, no matter how many troops it holds. Under the pre-ADR-069 rules a
// unit's base damage was a flat blueprint `siegeValue` on arrival, so a card team's total base damage
// was capped at ~150-190 for the whole battle, independent of troops:
//   · `npcBaseHp = 40 × level` ≥ that ceiling from level 5 up → 5-10级空地 were unbreakable by ANY card
//     team, at any troop count, forever (verified against production battles for account `tao`, s2-0);
//   · while `SIEGE_CHEAP_RATIO = 10` auto-won those same tiles the moment nominal troops reached
//     10× garrison — so mass beat the engine route, and the curve ran backwards.
// occupyBaseHpRun.ts could not see any of this (its army has 49 units at level 10), and its own
// "gear/academy hp makes no measurable difference" INFO line was that ceiling showing through.
//
// ADR-069 makes a pre-placed unit's siege value scale with the troops it carries
// (`siegeValue × troops / SIEGE_TROOPS_PER_UNIT`), which turns base HP back into a real, scalable gate.
// This tool re-calibrates it against card teams: for each roster tier × candidate `npcBaseHp` slope it
// finds the minimum troops-per-card that reliably captures each tile level, then checks the design
// invariants the old tool structurally could not.
//
// Run: npm run --workspace @nw/econ-sim occupy-card-team
import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  UnitType,
  Side,
  ATTACK_LANES,
  parseLevelDefinition,
  type GarrisonEntry,
  type EngineCardInstance,
} from '@nw/engine';
import {
  buildSiegeBattle,
  npcGarrison,
  npcBaseHp,
  SLG_MAP_MAX_LEVEL,
  SIEGE_CHEAP_RATIO,
  CARD_TEAM_MAX_SIZE,
  CARD_DEFS,
} from '@nw/shared';

const TICK_MARGIN = 600;
const SEEDS = [1, 2, 3, 4, 5];

/**
 * The 12-card mix a player realistically fields: an infantry/shieldbearer core with archer reach plus
 * one of each Anna-faction character. Card ids are real `CARD_DEFS` entries so `unitType` (and thus the
 * blueprint the engine bakes) is never invented here.
 */
const TEAM_DEF_IDS = [
  'lichuang', 'lichuang', 'lichuang', 'lichuang', // infantry ×4
  'chenshou', 'chenshou', 'chenshou',             // shieldbearer ×3
  'suyuan', 'suyuan',                             // archer ×2
  'max', 'lena', 'mara',                          // one each
];

if (TEAM_DEF_IDS.length !== CARD_TEAM_MAX_SIZE) {
  throw new Error(`team mix must be exactly CARD_TEAM_MAX_SIZE (${CARD_TEAM_MAX_SIZE}) cards`);
}

/** Roster tiers: card level only. Gear is left out on purpose — see the note under the tables. */
const TIERS = [
  { name: 'starter (Lv.1 cards)', cardLevel: 1 },
  { name: 'mid     (Lv.4 cards)', cardLevel: 4 },
  { name: 'veteran (Lv.8 cards)', cardLevel: 8 },
];

/**
 * Candidate `SLG_NPC_BASE_HP_PER_LEVEL` values to compare. `SHIPPED` is read from @nw/shared rather than
 * hard-coded so this file cannot silently drift from the constant it calibrates.
 */
const SHIPPED_SLOPE = npcBaseHp(1);
const BASE_HP_SLOPES = [40, 60, 80, 120, 160];

function cardInstances(cardLevel: number): EngineCardInstance[] {
  return TEAM_DEF_IDS.map((defId, i) => {
    const def = CARD_DEFS[defId];
    if (!def) throw new Error(`unknown card def '${defId}'`);
    return {
      id: `sim_${defId}_${i}`,
      defId,
      unitType: def.unitType as UnitType,
      level: cardLevel,
      gear: {},
    };
  });
}

/** Team formation: 12 cards round-robin across the attack lanes, two ranks deep (rows 3-4). */
function teamArmy(cardLevel: number, troopsPerCard: number): GarrisonEntry[] {
  return TEAM_DEF_IDS.map((defId, i) => {
    const def = CARD_DEFS[defId]!;
    return {
      unitType: def.unitType as UnitType,
      col: ATTACK_LANES[i % ATTACK_LANES.length]!,
      row: 3 + Math.floor(i / ATTACK_LANES.length),
      initialHp: troopsPerCard,
    };
  });
}

/** Defender garrison: the same deterministic synthesis worldsvc uses for an NPC tile (60 troops/unit). */
function npcGarrisonArmy(troops: number): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  const army: GarrisonEntry[] = [];
  for (let i = 0; remaining > 0; i++) {
    const hp = Math.min(60, remaining);
    remaining -= hp;
    army.push({
      unitType: UnitType.Infantry,
      col: ATTACK_LANES[i % ATTACK_LANES.length]!,
      row: Math.max(3, 16 - Math.floor(i / ATTACK_LANES.length)),
      initialHp: hp,
    });
  }
  return army;
}

function attackerWins(
  tileLevel: number, troopsPerCard: number, cardLevel: number, baseHp: number, seed: number,
): boolean {
  const defenderConfig = { garrison: npcGarrisonArmy(npcGarrison(tileLevel)), defenderBaseHp: baseHp };
  const levelObj = buildSiegeBattle({ army: teamArmy(cardLevel, troopsPerCard) }, defenderConfig, tileLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless(
    { seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level, cardInstances: cardInstances(cardLevel) },
    input,
    timeout + TICK_MARGIN,
  );
  return engine.state.winner === Side.Bottom;
}

const winsAll = (tileLevel: number, tpc: number, cardLevel: number, baseHp: number): boolean =>
  SEEDS.every((s) => attackerWins(tileLevel, tpc, cardLevel, baseHp, s));

/**
 * Minimum troops-per-card that wins on every seed, or null if even TROOPS_CAP can't.
 * Exponential probe (25 → 1600) then a binary refine to a 5-troop granularity: the outcome is
 * monotone in troops under ADR-069 (more troops = strictly more base damage and more HP), so a
 * bisection is sound where the old tool's linear 60-step scan would have been needlessly slow.
 */
const TROOPS_CAP = 1600;
function minTroopsPerCard(tileLevel: number, cardLevel: number, baseHp: number): number | null {
  let hi = 25;
  while (hi <= TROOPS_CAP && !winsAll(tileLevel, hi, cardLevel, baseHp)) hi *= 2;
  if (hi > TROOPS_CAP) return null;
  let lo = hi === 25 ? 1 : hi / 2;
  while (hi - lo > 5) {
    const mid = Math.floor((lo + hi) / 2);
    if (winsAll(tileLevel, mid, cardLevel, baseHp)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Troops-per-card at which `shouldUseCheapSiege` hands the tile over without running the engine. */
const cheapThresholdPerCard = (tileLevel: number): number =>
  Math.ceil((npcGarrison(tileLevel) * SIEGE_CHEAP_RATIO) / CARD_TEAM_MAX_SIZE);

const fmt = (n: number | null) => (n === null ? `>${TROOPS_CAP}` : String(n));

console.log(`Empty-land capture thresholds for a real ${CARD_TEAM_MAX_SIZE}-card team (ADR-069 siege-value scaling).`);
console.log(`Cell = minimum troops PER CARD that captures the tile on all ${SEEDS.length} seeds; "cheap" = the`);
console.log(`SIEGE_CHEAP_RATIO=${SIEGE_CHEAP_RATIO} shortcut's own per-card threshold (engine skipped, auto-win).\n`);

type Row = { tileLevel: number; perSlope: (number | null)[]; cheap: number };
const tierRows: { tier: string; rows: Row[] }[] = [];

for (const tier of TIERS) {
  console.log(`── ${tier.name} ──`);
  console.log('tile | garrison |  cheap | ' + BASE_HP_SLOPES.map((s) => `base=${s}×L`.padStart(11)).join(' '));
  console.log('-----|----------|--------|' + BASE_HP_SLOPES.map(() => '-'.repeat(12)).join(''));
  const rows: Row[] = [];
  for (let tileLevel = 1; tileLevel <= SLG_MAP_MAX_LEVEL; tileLevel++) {
    const perSlope = BASE_HP_SLOPES.map((slope) => minTroopsPerCard(tileLevel, tier.cardLevel, slope * tileLevel));
    const cheap = cheapThresholdPerCard(tileLevel);
    rows.push({ tileLevel, perSlope, cheap });
    console.log(
      `${String(tileLevel).padStart(4)} | ${String(npcGarrison(tileLevel)).padStart(8)} | ${String(cheap).padStart(6)} | ` +
      perSlope.map((v, i) => `${fmt(v)}${BASE_HP_SLOPES[i] === SHIPPED_SLOPE ? '*' : ''}`.padStart(11)).join(' '),
    );
  }
  tierRows.push({ tier: tier.name, rows });
  console.log('');
}

console.log(`* = the currently shipped SLG_NPC_BASE_HP_PER_LEVEL (${SHIPPED_SLOPE}). Gear is deliberately absent from every`);
console.log('  tier: equipment adds up to +60% siege value (EFFECT_CAPS.siegePct) on top of card level, so a');
console.log('  geared roster sits BELOW these thresholds — they are the pessimistic end of the band.\n');

// ── What each roster tier can ACTUALLY field (the decisive constraint) ────────────────────────
// A card's troop allotment is capped at `troopCapBase + troopCapGrowth × (level-1)` per card
// (client/src/game/meta/cardDefs.ts `troopCap()`; note the SERVER does not currently re-check this in
// distributeTroops, so it is a client-side rule — treat these capacities as the design intent, not an
// enforced invariant). Thresholds above are per-card troop counts, so a tier can only take a tile level
// whose threshold fits inside its own average per-card capacity — that, not the raw threshold, is what
// decides which rings a roster can occupy.
const tierCapacity = (cardLevel: number): number => {
  const total = TEAM_DEF_IDS.reduce((sum, defId) => {
    const def = CARD_DEFS[defId]!;
    return sum + def.troopCapBase + def.troopCapGrowth * (Math.max(1, cardLevel) - 1);
  }, 0);
  return Math.floor(total / CARD_TEAM_MAX_SIZE);
};

console.log('Max tile level each tier can capture when every card is filled to its own troop cap:');
console.log('tier                 | avg cap/card | ' + BASE_HP_SLOPES.map((sl) => `base=${sl}×L`.padStart(10)).join(' '));
console.log('---------------------|--------------|' + BASE_HP_SLOPES.map(() => '-'.repeat(11)).join(''));
for (let ti = 0; ti < TIERS.length; ti++) {
  const tier = TIERS[ti]!;
  const cap = tierCapacity(tier.cardLevel);
  const rows = tierRows[ti]!.rows;
  const maxLevels = BASE_HP_SLOPES.map((_, si) => {
    let best = 0;
    for (const r of rows) {
      const need = r.perSlope[si] ?? null;
      if (need !== null && need <= cap) best = r.tileLevel;
      else break; // thresholds are monotone by level — the first miss ends the reachable band
    }
    return best;
  });
  console.log(
    `${tier.name.padEnd(20)} | ${String(cap).padStart(12)} | ` +
    maxLevels.map((l) => (l === 0 ? 'none' : `L${l}`).padStart(10)).join(' '),
  );
}
console.log('(Equipment adds up to +60% siege value → roughly one ring further per tier than shown.)\n');

// ── Invariants ────────────────────────────────────────────────────────────────────────────────
console.log('Verdict:');
let pass = true;

// ① Every tile level must be capturable by the engine route at some sane troop count — the whole
//    point of ADR-069. A `null` here is the pre-ADR-069 unbreakable-wall bug reappearing.
for (const { tier, rows } of tierRows) {
  for (const { tileLevel, perSlope } of rows) {
    for (let i = 0; i < BASE_HP_SLOPES.length; i++) {
      if ((perSlope[i] ?? null) === null && BASE_HP_SLOPES[i]! <= 200 && tier.startsWith('mid')) {
        console.log(`  [FAIL] ${tier}: L${tileLevel} unreachable at base=${BASE_HP_SLOPES[i]}×L even with ${TROOPS_CAP} troops/card`);
        pass = false;
      }
    }
  }
}

// ② Difficulty must not run backwards: more valuable land must never be cheaper to take.
for (const { tier, rows } of tierRows) {
  for (let i = 0; i < BASE_HP_SLOPES.length; i++) {
    for (let r = 1; r < rows.length; r++) {
      const prev = rows[r - 1]!.perSlope[i] ?? null;
      const cur = rows[r]!.perSlope[i] ?? null;
      // Tolerance: the search granularity is 5 troops and the defender formation's LANE GEOMETRY
      // changes with unit count (a level-8 garrison fills a second rank differently than level 7),
      // so a percent-level dip between adjacent levels is measurement noise, not an inverted gate.
      // Anything beyond that is a real inversion and fails.
      const tol = Math.max(5, (prev ?? 0) * 0.05);
      if (prev !== null && cur !== null && cur < prev - tol) {
        console.log(`  [FAIL] ${tier} base=${BASE_HP_SLOPES[i]}×L: L${rows[r]!.tileLevel} (${cur}) is materially cheaper than L${rows[r - 1]!.tileLevel} (${prev})`);
        pass = false;
      }
    }
  }
}

// ③ The engine route must stay cheaper than the SIEGE_CHEAP_RATIO shortcut. Otherwise the optimal
//    play is to ignore team quality and mass troops until the shortcut fires — exactly the inverted
//    incentive ADR-069 exists to remove.
for (const { tier, rows } of tierRows) {
  for (let i = 0; i < BASE_HP_SLOPES.length; i++) {
    const violations = rows.filter((r) => {
      const v = r.perSlope[i] ?? null;
      return v === null || v >= r.cheap;
    });
    if (violations.length > 0 && tier.startsWith('mid')) {
      console.log(
        `  [WARN] ${tier} base=${BASE_HP_SLOPES[i]}×L: shortcut is cheaper than (or equal to) the engine route at ` +
        `L${violations.map((v) => v.tileLevel).join(',')}`,
      );
    }
  }
}

console.log(pass ? '  [PASS] every tile level is reachable and difficulty is monotone by level.' : '  see failures above.');
console.log(`\nShipped constant check: npcBaseHp(1..${SLG_MAP_MAX_LEVEL}) = ` +
  Array.from({ length: SLG_MAP_MAX_LEVEL }, (_, i) => npcBaseHp(i + 1)).join(', '));
