import { FP_SCALE, TICK_RATE } from './math/fixed';
import {
  BuildingType,
  CardType,
  SpellType,
  UnitType,
  type BuildingBlueprint,
  type CardDefinition,
  type UnitBlueprint,
} from './types';

// ─── Board layout ─────────────────────────────────────────────────────────────
//
//  Row 0   : Bottom player building row  (own building row)
//  Row 1   : Bottom player spawn row     (own spawn row)
//  Row 2-15: Combat zone                 (combat zone, 14 rows)
//  Row 16  : Top player spawn row        (enemy spawn row)
//  Row 17  : Top player building row     (enemy building row)
//
//  All rows/cols are 0-indexed.

export const BOARD_COLS = 12;
export const BOARD_ROWS = 18; // rows 0–17

/** 0-indexed cols occupied by bases (center 2 columns) */
export const BASE_COLS = [5, 6] as const;

/** 0-indexed attack lanes (all cols except base cols 5–6) */
export const ATTACK_LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] as const;

/** Building row for bottom player (row 0 = bottom of screen) */
export const BOTTOM_BUILDING_ROW = 0;
/** Building row for top player (row 17 = top of screen) */
export const TOP_BUILDING_ROW = 17;

/** Unit spawn row for bottom player (just above building row) */
export const BOTTOM_SPAWN_ROW = 1;
/** Unit spawn row for top player (just below building row) */
export const TOP_SPAWN_ROW = 16;

// ─── Resource ─────────────────────────────────────────────────────────────────

export const INK_REGEN_BASE = 2;      // ink / second (reference only)
export const INK_CAP = 300;
export const BASE_UPGRADE_COSTS = [50, 100, 200] as const;
export const BASE_UPGRADE_REGEN_BONUS = 1; // +1 ink/s per upgrade level

/** Ink cost to manually refresh the whole hand (redraws all slots, like entry). */
export const HAND_REFRESH_COST = 10;

// ─── Tick-based ink regen (integer fp per tick, no floats) ──────────────────
//
//  Normal  : INK_REGEN_BASE ink/s           = trunc(2 * 1000 / 30)     =  66 fp/tick
//  Accel×1.5: INK_REGEN_BASE * 1.5 ink/s   = trunc(2 * 1000 * 3 / 60) = 100 fp/tick
//  Accel×2  : INK_REGEN_BASE * 2   ink/s   = trunc(2 * 1000 * 2 / 30) = 133 fp/tick
//  Upgrade bonus: +1 ink/s per level          = trunc(1 * 1000 / 30)     =  33 fp/tick
//
// Regen fp/tick per ink/s of regen rate, at each acceleration phase.
// Used to compute per-player regen: rate_per_tick * inkRegenRate(ink/s)
// Normal  (×1  ): trunc(1 * 1000 / 30)         =  33 fp / (ink/s) / tick
// Accel×1.5     : trunc(1 * 1000 * 3 / 60)     =  50 fp / (ink/s) / tick
// Accel×2       : trunc(1 * 1000 * 2 / 30)     =  66 fp / (ink/s) / tick
export const REGEN_FP_PER_INK_PER_S_NORMAL = Math.trunc(FP_SCALE          / TICK_RATE);           // 33
export const REGEN_FP_PER_INK_PER_S_ACCEL1 = Math.trunc(FP_SCALE * 3      / (TICK_RATE * 2));     // 50
export const REGEN_FP_PER_INK_PER_S_ACCEL2 = Math.trunc(FP_SCALE * 2      / TICK_RATE);           // 66

// ─── Time acceleration (tick thresholds) ─────────────────────────────────────
//
//  0–3 min   normal     ×1.0
//  3–6 min   accel 1    ×1.5
//  6–10 min  accel 2    ×2.0
//  10–13 min accel 3    ×4.0
//  13 min+   all-unit attack ×2
//  15 min    countdown starts
//  17 min    force draw

export const ACCEL_THRESHOLD_1        = 180; // seconds (reference only)
export const ACCEL_THRESHOLD_2        = 360; // seconds (reference only)
export const ACCEL_THRESHOLD_3        = 600; // seconds (reference only)
export const ACCEL_THRESHOLD_1_TICKS  = ACCEL_THRESHOLD_1 * TICK_RATE; // 5400
export const ACCEL_THRESHOLD_2_TICKS  = ACCEL_THRESHOLD_2 * TICK_RATE; // 10800
export const ACCEL_THRESHOLD_3_TICKS  = ACCEL_THRESHOLD_3 * TICK_RATE; // 18000

// Accel ×4.0: trunc(4 * 1000 / 30) = 133 fp / (ink/s) / tick
export const REGEN_FP_PER_INK_PER_S_ACCEL3 = Math.trunc(FP_SCALE * 4 / TICK_RATE); // 133

export const ATTACK_MULT_THRESHOLD        = 780; // 13 min (seconds, reference only)
export const ATTACK_MULT_THRESHOLD_TICKS  = ATTACK_MULT_THRESHOLD * TICK_RATE; // 23400
/** All-unit attack multiplier applied after ATTACK_MULT_THRESHOLD_TICKS. */
export const ATTACK_MULT_LATE_GAME        = 2;

export const COUNTDOWN_THRESHOLD        = 900;  // 15 min (seconds, reference only)
export const COUNTDOWN_THRESHOLD_TICKS  = COUNTDOWN_THRESHOLD * TICK_RATE; // 27000

export const FORCE_DRAW_THRESHOLD        = 1020; // 17 min (seconds, reference only)
export const FORCE_DRAW_THRESHOLD_TICKS  = FORCE_DRAW_THRESHOLD * TICK_RATE; // 30600

// ─── Hand / card refresh ──────────────────────────────────────────────────────
//
//  Each hand slot has an independent countdown timer.
//  When it expires (30 s without playing, see CARD_REFRESH_TICKS), the card is auto-refreshed.
//  Initial timers are staggered by a random offset [0, CARD_REFRESH_INITIAL_OFFSET_MAX]
//  to prevent all 6 slots from expiring simultaneously.

export const HAND_SIZE = 6;

/** Auto-refresh countdown: 30 s × 30 ticks/s = 900 ticks */
export const CARD_REFRESH_TICKS = 30 * TICK_RATE; // 900

/** Maximum initial stagger offset: 15 s × 30 ticks/s = 450 ticks */
export const CARD_REFRESH_INITIAL_OFFSET_MAX = 15 * TICK_RATE; // 450

// ─── Base HP ──────────────────────────────────────────────────────────────────

export const BASE_HP = 100;

// ─── Building tick intervals ──────────────────────────────────────────────────
//
//  Barracks spawn interval : 6 s   → 6 * 30 = 180 ticks
//  Arrow tower attack      : 1.5 s → round(1.5 * 30) = 45 ticks
//
// Barracks were overpowered: a 10-ink building paid for itself in ~20 s then
// produced infinite value. Slowed the stream (4 s → 6 s, −33% output) and the
// card cost was raised (see CARD_DEFINITIONS) to bring it in line with towers.
export const BARRACKS_SPAWN_INTERVAL_TICKS     = 6 * TICK_RATE;                   // 180
export const ARROW_TOWER_ATTACK_INTERVAL_TICKS = Math.round(1.5 * TICK_RATE);     // 45

// ─── Spell tick durations ─────────────────────────────────────────────────────

export const HASTE_DURATION_TICKS = 5 * TICK_RATE;  // 150 ticks

// ─── Unit blueprints ──────────────────────────────────────────────────────────

export const UNIT_BLUEPRINTS: Record<UnitType, UnitBlueprint> = {
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
  // Harpy: PvE-only flying unit. flying=true means ground melee can't target it
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
  // Medic: PvE-only support. No attack (range 0, attack 0, extreme interval so the
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
  // Berserker: PvE-only rage brawler. Below 40% HP its attack interval halves
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
  // Splitter: PvE-only bomb unit. Dies and immediately spawns 2 Runners at its
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
  // see pvpSim.ts / BALANCE.md §5.1). Cutting attack to 14 (still > Infantry 12,
  // < Berserker 18) keeps the durable-vanguard identity but removes the DPS
  // overload; paired with cost 5→6 (CARD_DEFINITIONS) it lands ~54% equal-ink.
  [UnitType.Max]: {
    type: UnitType.Max,
    hp: 190,
    attack: 14,
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

// ─── Building blueprints ──────────────────────────────────────────────────────

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
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

// ─── Card definitions (pool) ──────────────────────────────────────────────────

export const CARD_DEFINITIONS: CardDefinition[] = [
  { id: 'infantry_1', nameKey: 'card.infantry.name', descKey: 'card.infantry.desc', cardType: CardType.Unit,     cost: 4,  unitType: UnitType.Infantry       },
  { id: 'infantry_2', nameKey: 'card.infantry.name', descKey: 'card.infantry.desc', cardType: CardType.Unit,     cost: 4,  unitType: UnitType.Infantry       },
  { id: 'shieldbearer_1',  nameKey: 'card.shieldbearer.name',  descKey: 'card.shieldbearer.desc',  cardType: CardType.Unit,     cost: 6,  unitType: UnitType.ShieldBearer        },
  { id: 'shieldbearer_2',  nameKey: 'card.shieldbearer.name',  descKey: 'card.shieldbearer.desc',  cardType: CardType.Unit,     cost: 6,  unitType: UnitType.ShieldBearer        },
  { id: 'archer_1',    nameKey: 'card.archer.name',    descKey: 'card.archer.desc',    cardType: CardType.Unit,     cost: 5,  unitType: UnitType.Archer          },
  { id: 'archer_2',    nameKey: 'card.archer.name',    descKey: 'card.archer.desc',    cardType: CardType.Unit,     cost: 5,  unitType: UnitType.Archer          },
  // Anna-side units (A6) — permanently in PvP base pool; no PvE gate (PVP_LOADOUT_DESIGN §7)
  { id: 'max_1',  nameKey: 'card.max.name',  descKey: 'card.max.desc',  cardType: CardType.Unit, cost: 6, unitType: UnitType.Max  },
  { id: 'max_2',  nameKey: 'card.max.name',  descKey: 'card.max.desc',  cardType: CardType.Unit, cost: 6, unitType: UnitType.Max  },
  { id: 'lena_1', nameKey: 'card.lena.name', descKey: 'card.lena.desc', cardType: CardType.Unit, cost: 7, unitType: UnitType.Lena },
  { id: 'lena_2', nameKey: 'card.lena.name', descKey: 'card.lena.desc', cardType: CardType.Unit, cost: 7, unitType: UnitType.Lena },
  { id: 'mara_1', nameKey: 'card.mara.name', descKey: 'card.mara.desc', cardType: CardType.Unit, cost: 5, unitType: UnitType.Mara },
  { id: 'mara_2', nameKey: 'card.mara.name', descKey: 'card.mara.desc', cardType: CardType.Unit, cost: 5, unitType: UnitType.Mara },
  // PvP unlock units (PVP_LOADOUT_DESIGN §3 — one entry each, no _1/_2 duplicates).
  // Costs validated by the P4 PvP duel sim (client/test/pvpSim.ts): runner 3 (59% equal-ink;
  // dropping to 2 is oppressive at 82%), ironclad 8 / berserker 6 are balanced (~45–50%),
  // harpy 7 is the deliberate high-cost guardrail for unanswerable flying (sim shows it is
  // never oppressive → no extra flying mechanic added), medic 6 is non-oppressive support.
  // Splitter raised 4→5: its on-death 2-Runner split wins ~100% of equal-ink melee trades at
  // any cost in 4–6; the real counter is AOE (meteor), which the arena cannot model, so cost 5
  // aligns it with the 5-bracket while meteor remains its hard answer (BALANCE.md §5.3).
  { id: 'runner',    nameKey: 'card.runner.name',    descKey: 'card.runner.desc',    cardType: CardType.Unit, cost: 3, unitType: UnitType.Runner    },
  { id: 'ironclad',  nameKey: 'card.ironclad.name',  descKey: 'card.ironclad.desc',  cardType: CardType.Unit, cost: 8, unitType: UnitType.Ironclad  },
  { id: 'berserker', nameKey: 'card.berserker.name', descKey: 'card.berserker.desc', cardType: CardType.Unit, cost: 6, unitType: UnitType.Berserker },
  { id: 'splitter',  nameKey: 'card.splitter.name',  descKey: 'card.splitter.desc',  cardType: CardType.Unit, cost: 5, unitType: UnitType.Splitter  },
  { id: 'harpy',     nameKey: 'card.harpy.name',     descKey: 'card.harpy.desc',     cardType: CardType.Unit, cost: 7, unitType: UnitType.Harpy     },
  { id: 'medic',     nameKey: 'card.medic.name',     descKey: 'card.medic.desc',     cardType: CardType.Unit, cost: 6, unitType: UnitType.Medic     },
  { id: 'barracks_1',  nameKey: 'card.barracks.name',  descKey: 'card.barracks.desc',  cardType: CardType.Building, cost: 14, buildingType: BuildingType.Barracks   },
  { id: 'barracks_2',  nameKey: 'card.barracks.name',  descKey: 'card.barracks.desc',  cardType: CardType.Building, cost: 14, buildingType: BuildingType.Barracks   },
  { id: 'tower_1',     nameKey: 'card.tower.name',     descKey: 'card.tower.desc',     cardType: CardType.Building, cost: 12, buildingType: BuildingType.ArrowTower },
  { id: 'tower_2',     nameKey: 'card.tower.name',     descKey: 'card.tower.desc',     cardType: CardType.Building, cost: 12, buildingType: BuildingType.ArrowTower },
  { id: 'haste_1',     nameKey: 'card.haste.name',     descKey: 'card.haste.desc',     cardType: CardType.Spell,    cost: 8,  spellType: SpellType.Haste         },
  { id: 'meteor_1',    nameKey: 'card.meteor.name',    descKey: 'card.meteor.desc',    cardType: CardType.Spell,    cost: 12, spellType: SpellType.Meteor        },
];

// ─── Spell parameters ─────────────────────────────────────────────────────────

export const HASTE_SPEED_MULT = 2;    // integer multiplier — used with scaleFp()
export const METEOR_DAMAGE    = 9999; // one-shots anything in 2×2 area

// PvE-only level spell parameters
export const ROCKSLIDE_DAMAGE              = 80;
export const BRIDGE_COLLAPSE_DURATION_TICKS = 8 * TICK_RATE; // 240 ticks = 8s

/**
 * PvE-only level-specific spell card definitions.
 * These MUST NOT appear in CARD_DEFINITIONS (the PvP pool) — hard wall.
 * Injected into the bottom player's draw pool via levelSpells level config.
 */
export const SPELL_CARD_DEFS: ReadonlyMap<string, CardDefinition> = new Map<string, CardDefinition>([
  ['rockslide', {
    id:        'rockslide',
    nameKey:   'card.rockslide.name' as CardDefinition['nameKey'],
    descKey:   'card.rockslide.desc' as CardDefinition['descKey'],
    cardType:  CardType.Spell,
    cost:      3,
    spellType: SpellType.Rockslide,
  }],
  ['bridge_collapse', {
    id:        'bridge_collapse',
    nameKey:   'card.bridge_collapse.name' as CardDefinition['nameKey'],
    descKey:   'card.bridge_collapse.desc' as CardDefinition['descKey'],
    cardType:  CardType.Spell,
    cost:      4,
    spellType: SpellType.BridgeCollapse,
  }],
]);
