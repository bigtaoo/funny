// Unit + building blueprint tables, split out of config.ts (2026-08-12, "server/ 500-line
// convention" drift caused by ADR-065's raw-table/bake split — see claudedocs/server.md's
// "单文件 500 行收敛" section for the general pattern: thin assembly shell + export, zero
// external call-site changes). config.ts re-exports UNIT_BLUEPRINTS/BUILDING_BLUEPRINTS from
// here so every existing `from './config'` import keeps working unchanged.
import { toFp } from './math/fixed';
import {
  BuildingType,
  UnitType,
  type BuildingBlueprint,
  type UnitBlueprint,
} from './types';

// ─── Unit blueprints ──────────────────────────────────────────────────────────
//
// ADR-065: this table is the human-authored, REAL-UNIT source of truth (hp: 60,
// not 60000) — exactly the pre-ADR-065 shape, so it stays the single legible
// place to tune numbers and cross-check against BALANCE.md/ECONOMY_NUMBERS.md.
// `bakeUnitBlueprint` converts it once, at module load, into the fp-scaled
// `UnitBlueprint` shape (`hp_fp`, `attack_fp`, …) that the rest of the engine
// (balance/*.ts, Unit.ts, combat systems) consumes. Discrete/already-converted
// fields (attackInterval, speed, range, spawnCount, radius_fp, splashRadius,
// projectile.speed, summonOnTimer.intervalSec, slowOnHit.durationSec) pass
// through unchanged — they were never part of this ADR's scope.

/** Real-unit authoring shape for `UnitBlueprint` (ADR-065) — see comment above. */
export type RawUnitBlueprint = Omit<UnitBlueprint,
  | 'hp_fp' | 'attack_fp' | 'siegeValue_fp' | 'armor_fp' | 'armorEnrageBonus_fp'
  | 'berserkerThreshold_fp' | 'armorEnrageThreshold_fp' | 'reflectPct_fp'
  | 'critPct_fp' | 'critMult_fp' | 'lifestealPct_fp' | 'burstOnSingleMult_fp' | 'slowOnHit'
> & {
  hp: number;
  attack: number;
  siegeValue: number;
  armor?: number;
  armorEnrageBonus?: number;
  berserkerThreshold?: number;
  armorEnrageThreshold?: number;
  reflectPct?: number;
  critPct?: number;
  critMult?: number;
  lifestealPct?: number;
  burstOnSingleMult?: number;
  slowOnHit?: { mult: number; durationSec: number };
};

/**
 * Converts one real-unit `RawUnitBlueprint` into the fp-scaled `UnitBlueprint` (ADR-065).
 *
 * Exported only as a TEST SEAM (2026-09-03). It is called exactly once per table entry at
 * module load, so which of its per-field `!== undefined` arms ever run is decided entirely by
 * which optional stats today's `RAW_UNIT_BLUEPRINTS` happens to set — eight of them
 * (`armorEnrageBonus`, `armorEnrageThreshold`, `reflectPct`, `critPct`, `critMult`,
 * `lifestealPct`, `burstOnSingleMult`, `slowOnHit`) are set by NO unit, so the fp-scaling half
 * of each is unreachable from outside this file. Those fields are not dead code: they are read
 * by TraitSystem/CombatSystem and are what a designer adds to a raw entry to give a unit crit,
 * lifesteal or an on-hit slow. If one of them were dropped from the destructuring or scaled
 * with the wrong helper, the unit would silently ship with the stat missing (`...rest` does not
 * carry it, since the field is renamed to `*_fp`) — nothing would throw and no other test would
 * notice, because no unit exercises it yet. `blueprint-bake.test.ts` covers all of them.
 * Nothing outside the tests imports it, and `index.ts` does not re-export it.
 */
export function bakeUnitBlueprint(raw: RawUnitBlueprint): UnitBlueprint {
  const {
    hp, attack, siegeValue, armor, armorEnrageBonus, berserkerThreshold,
    armorEnrageThreshold, reflectPct, critPct, critMult, lifestealPct,
    burstOnSingleMult, slowOnHit, ...rest
  } = raw;
  return {
    ...rest,
    hp_fp: toFp(hp),
    attack_fp: toFp(attack),
    siegeValue_fp: toFp(siegeValue),
    armor_fp: armor !== undefined ? toFp(armor) : undefined,
    armorEnrageBonus_fp: armorEnrageBonus !== undefined ? toFp(armorEnrageBonus) : undefined,
    berserkerThreshold_fp: berserkerThreshold !== undefined ? toFp(berserkerThreshold) : undefined,
    armorEnrageThreshold_fp: armorEnrageThreshold !== undefined ? toFp(armorEnrageThreshold) : undefined,
    reflectPct_fp: reflectPct !== undefined ? toFp(reflectPct) : undefined,
    critPct_fp: critPct !== undefined ? toFp(critPct) : undefined,
    critMult_fp: critMult !== undefined ? toFp(critMult) : undefined,
    lifestealPct_fp: lifestealPct !== undefined ? toFp(lifestealPct) : undefined,
    burstOnSingleMult_fp: burstOnSingleMult !== undefined ? toFp(burstOnSingleMult) : undefined,
    slowOnHit: slowOnHit ? { mult_fp: toFp(slowOnHit.mult), durationSec: slowOnHit.durationSec } : undefined,
  };
}

function bakeUnitBlueprints(raw: Record<UnitType, RawUnitBlueprint>): Record<UnitType, UnitBlueprint> {
  const out = {} as Record<UnitType, UnitBlueprint>;
  for (const key of Object.keys(raw) as UnitType[]) out[key] = bakeUnitBlueprint(raw[key]);
  return out;
}

const RAW_UNIT_BLUEPRINTS: Record<UnitType, RawUnitBlueprint> = {
  [UnitType.Infantry]: {
    type: UnitType.Infantry,
    hp: 60,
    attack: 12,
    attackInterval: 0.8,  // seconds (converted to ticks in Unit constructor)
    speed: 1.4,           // grid/s  (converted to fp in Unit constructor)
    range: 1,
    spawnCount: 2,
    radius_fp: 400,       // diameter 800fp = 0.8 cells
    siegeValue: 11,       // line troop: solid all-round sieger (mirrors CARD_DEFS)
  },
  // Tank: leads the line and soaks fire so squishier units survive behind it.
  // HP/ink (40) is clearly above Infantry (30) — that's its whole identity — at
  // the cost of low DPS and the slowest speed. Walls infantry, breaks towers,
  // but threatens little alone (ignore-and-flank it, or AoE the clump it forms).
  [UnitType.ShieldBearer]: {
    type: UnitType.ShieldBearer,
    hp: 240,
    attack: 8,
    attackInterval: 1.2,
    speed: 0.85,
    range: 1,
    spawnCount: 1,
    radius_fp: 500,       // diameter 1000fp = 1.0 cell
    siegeValue: 14,       // wall-breaker identity → top-tier siege (mirrors CARD_DEFS)
  },
  // Glass cannon: range 2 lets it hit before melee reaches and shoot over/around
  // a shield ahead (surrounding-cell targeting). Highest per-hit damage of the
  // three, but 35 HP folds to one arrow tower / any melee that closes in — it
  // wants a tank in front, never the front line itself.
  [UnitType.Archer]: {
    type: UnitType.Archer,
    hp: 35,
    attack: 22,
    attackInterval: 1.4,
    speed: 1.1,
    range: 2,             // 2-grid range (down from 3)
    spawnCount: 1,
    radius_fp: 350,       // diameter 700fp = 0.7 cells
    siegeValue: 8,        // glass cannon: weakest at battering structures (mirrors CARD_DEFS)
    // Fires an arrow that travels to its target rather than dealing instant damage.
    // 14 grid/s over a ≤2-cell range ≈ 0.15 s flight — visibly a shot, but fast
    // enough that it rarely whiffs except when the target dies/flees mid-air.
    projectile: { speed: 14, kind: 'arrow' },
    canTargetFlying: true, // only unit type that can hit Harpy besides arrow towers (types.ts:22)
  },
  // ── Reused units (PvE waves + reused in the PvP pool via PVP_LOADOUT_DESIGN) ──
  // NOTE: all six below are PvE waves AND rank-gated PvP cards since PVP-P1 (2026-06-30) —
  // they have CARD_DEFINITIONS entries. Do not describe them as "PvE-only" (the per-unit
  // comments said exactly that until 2026-09-03, contradicting this header and BALANCE.md §5.2).
  // No progression cards (CARD_DEFS covers only the six heroes), so their siegeValue
  // lives only here — the engine blueprint is the single source for PvP.
  // Ironclad: anti-arrow damage sponge. armor=3 makes arrow tower (15 dmg) deal
  // max(1, 15-3)=12 per hit (8 dps) → TTK ≈ 36 s, vs 29 s without armor. Forces
  // meteor / melee to clear it before it reaches buildings. Very slow; does not
  // outrun your reaction; it just refuses to die cheaply to ranged fire alone.
  [UnitType.Ironclad]: {
    type: UnitType.Ironclad,
    hp: 290,
    attack: 10,
    attackInterval: 1.5,
    speed: 0.5,
    range: 1,
    spawnCount: 1,
    radius_fp: 520,       // diameter 1040fp ≈ 1.04 cells — fills its lane, leads stacks
    armor: 3,             // anti-arrow identity: arrow tower needs ~36 s (vs 29 s at armor 0)
    siegeValue: 15,       // heaviest tank (290 HP) → highest siege in the roster
  },
  // Runner: fast fragile rusher. One arrow-tower hit one-shots it, but it arrives
  // fast, wide and dense (small radius packs ~2× tighter than a infantry), so the
  // threat is the swarm, not the individual — the counter to single-file queueing.
  [UnitType.Runner]: {
    type: UnitType.Runner,
    hp: 30,
    attack: 9,
    attackInterval: 0.7,
    speed: 1.9,
    range: 1,
    spawnCount: 1,
    radius_fp: 250,       // diameter 500fp = 0.5 cells — dense swarm
    siegeValue: 6,        // fast fragile swarm: low per-unit siege, keeps it a harasser not a finisher
  },
  // Harpy: flying unit (PvE waves + PvP king-tier unlock). flying=true means ground melee can't target it
  // (only archers + arrow towers). Bypasses blocked cells. Fragile — one arrow-
  // tower volley kills it — but demands the player has placed towers, punishing
  // pure barracks builds. Small radius keeps it visually distinct from runners.
  [UnitType.Harpy]: {
    type: UnitType.Harpy,
    hp: 26,
    attack: 8,
    attackInterval: 0.9,
    speed: 2.2,
    range: 1,
    spawnCount: 1,
    radius_fp: 210,
    flying: true,
    canTargetFlying: false,
    siegeValue: 7,        // fragile flyer that bypasses defense: kept low so a fly-over rush can't finish
  },
  // Medic: support unit (PvE waves + PvP king-tier unlock; PvP gets a symbolic melee
  // override in buildPvpBlueprints). No attack here (range 0, attack 0, extreme interval so the
  // engine never fires). Emits an aura_heal that heals nearby allies for 8 HP/s.
  // Slow and soft, but a cluster escorted by a Medic becomes self-sustaining — must
  // be prioritised or the whole wave stops dying.
  [UnitType.Medic]: {
    type: UnitType.Medic,
    hp: 90,
    attack: 0,
    attackInterval: 999,
    speed: 0.55,
    range: 0,
    spawnCount: 1,
    radius_fp: 440,
    traits: [{ type: 'aura_heal', radius: 2, hps: 8 }],
    siegeValue: 4,        // support unit: symbolic siege only — not meant to batter the base
  },
  // Berserker: rage brawler (PvE waves + PvP grandmaster-tier unlock). Below 40% HP its attack interval halves
  // (×1.5 attack speed), making it increasingly dangerous the longer it survives.
  // Burst it down before the threshold or it shreds buildings faster than expected.
  [UnitType.Berserker]: {
    type: UnitType.Berserker,
    hp: 110,
    attack: 18,
    attackInterval: 1.1,
    speed: 1.1,
    range: 1,
    spawnCount: 1,
    radius_fp: 420,
    berserkerThreshold: 0.4,
    siegeValue: 13,       // building-shredder identity (see comment) → high siege
  },
  // Splitter: bomb unit (PvE waves + PvP grandmaster-tier unlock). Dies and immediately spawns 2 Runners at its
  // position. Ignoring it is worse than fighting it — killing it with area damage
  // (Meteor, Rockslide) clears all three units; single-target fire turns one slow
  // threat into two fast ones.
  [UnitType.Splitter]: {
    type: UnitType.Splitter,
    hp: 65,
    attack: 7,
    attackInterval: 1.0,
    speed: 0.8,
    range: 1,
    spawnCount: 1,
    radius_fp: 470,
    onDeathSpawn: { type: UnitType.Runner, count: 2 },
    siegeValue: 8,        // modest body; real pressure is the 2 Runners it splits into
  },
  // Max: Anna-side vanguard. burstOnSingle deals 2× damage when he is the last
  // standing enemy — a clean-up finisher that rewards holding him for the kill.
  // Light armor (2) makes him resilient to towers but not melee-proof.
  // PvP anchor rebalance (2026-07-02): attack 22→14. At 22 melee DPS Max was a
  // tank (190 HP + armor 2) that ALSO out-DPSed the field, winning ~91% of equal-
  // ink duels at any cost (cost-insensitive → a stat overload, not a price issue;
  // see pvpSim.ts / BALANCE.md §5.1). Cutting attack + cost 5→6 landed ~54%.
  // Ghost-fix re-tune (2026-07-17): the stacked-unit targeting fix (Board multi-
  // occupant grid) removed the swarm "ghost" artifact that had been suppressing
  // Max's real duel rate; equal-ink jumped 54%→73%, above the ≤65% guard. Trimming
  // attack 14→11 (now ≤ Infantry 12 — Max leans on 190 HP + armor 2 + burstOnSingle,
  // not raw DPS) restores the intended ~54% without touching the tank identity.
  [UnitType.Max]: {
    type: UnitType.Max,
    hp: 190,
    attack: 11,
    attackInterval: 1.3,
    speed: 1.0,
    range: 1,
    spawnCount: 1,
    radius_fp: 490,
    armor: 2,
    burstOnSingle: true,
    siegeValue: 12,       // armored vanguard: above-average siege (mirrors CARD_DEFS)
  },
  // Lena: Anna-side sentinel. disciplineArmor = armor 8; every hit reduced by 8
  // (minimum 1), making rapid light strikes nearly harmless while heavy single hits
  // still connect. Slow but nearly unkillable by arrow towers alone.
  [UnitType.Lena]: {
    type: UnitType.Lena,
    hp: 150,
    attack: 10,
    attackInterval: 1.0,
    speed: 0.75,
    range: 1,
    spawnCount: 1,
    radius_fp: 510,
    armor: 8,
    siegeValue: 14,       // sentinel tank: wall-breaker tier (mirrors CARD_DEFS)
  },
  // Mara: Anna-side skirmisher. markEnemies: arrows mark targets for +25 % bonus
  // damage from all sources for 3 s. Fragile and dies fast to melee; best behind
  // a tank. The mark synergises with any unit focusing the same target.
  [UnitType.Mara]: {
    type: UnitType.Mara,
    hp: 40,
    attack: 12,
    attackInterval: 1.3,
    speed: 1.4,
    range: 2,
    spawnCount: 1,
    radius_fp: 320,
    markEnemies: true,
    projectile: { speed: 14, kind: 'arrow' },
    siegeValue: 8,        // marker/dps: low structural damage like archers (mirrors CARD_DEFS)
  },
};

/** fp-scaled `UnitBlueprint` table (ADR-065) — see `RAW_UNIT_BLUEPRINTS` comment above. */
export const UNIT_BLUEPRINTS: Record<UnitType, UnitBlueprint> = bakeUnitBlueprints(RAW_UNIT_BLUEPRINTS);

// ─── Building blueprints ──────────────────────────────────────────────────────
//
// ADR-065: same raw-table/bake split as UNIT_BLUEPRINTS above — real units here,
// `bakeBuildingBlueprint` produces the fp-scaled `BuildingBlueprint` consumed by
// the engine.

/** Real-unit authoring shape for `BuildingBlueprint` (ADR-065). */
export type RawBuildingBlueprint = Omit<BuildingBlueprint, 'hp_fp' | 'attack_fp' | 'armor_fp'> & {
  hp: number;
  attack?: number;
  armor?: number;
};

/**
 * Converts one real-unit `RawBuildingBlueprint` into the fp-scaled `BuildingBlueprint` (ADR-065).
 * Exported as a test seam for the same reason as {@link bakeUnitBlueprint}: no building in
 * `RAW_BUILDING_BLUEPRINTS` sets `armor`, so that field's scaling arm has no other caller.
 */
export function bakeBuildingBlueprint(raw: RawBuildingBlueprint): BuildingBlueprint {
  const { hp, attack, armor, ...rest } = raw;
  return {
    ...rest,
    hp_fp: toFp(hp),
    attack_fp: attack !== undefined ? toFp(attack) : undefined,
    armor_fp: armor !== undefined ? toFp(armor) : undefined,
  };
}

function bakeBuildingBlueprints(raw: Record<BuildingType, RawBuildingBlueprint>): Record<BuildingType, BuildingBlueprint> {
  const out = {} as Record<BuildingType, BuildingBlueprint>;
  for (const key of Object.keys(raw) as BuildingType[]) out[key] = bakeBuildingBlueprint(raw[key]);
  return out;
}

const RAW_BUILDING_BLUEPRINTS: Record<BuildingType, RawBuildingBlueprint> = {
  [BuildingType.Barracks]: {
    type: BuildingType.Barracks,
    hp: 200,
    spawnUnit: UnitType.Infantry,
    spawnInterval: 6,         // seconds — actual cadence lives in BARRACKS_SPAWN_INTERVAL_TICKS
  },
  [BuildingType.ArrowTower]: {
    type: BuildingType.ArrowTower,
    hp: 120,
    attack: 15,
    attackInterval: 1.5,      // seconds (converted to ticks in Building constructor)
    attackRange: 2,            // 2-grid range (down from 3)
    canTargetFlying: true,
    // Arrow tower also lobs an arrow rather than zapping instantly (same as archers).
    projectile: { speed: 14, kind: 'arrow' },
  },
};

/** fp-scaled `BuildingBlueprint` table (ADR-065) — see `RAW_BUILDING_BLUEPRINTS` comment above. */
export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = bakeBuildingBlueprints(RAW_BUILDING_BLUEPRINTS);
