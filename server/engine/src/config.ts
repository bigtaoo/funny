import { FP_SCALE, TICK_RATE } from './math/fixed';
import {
  BuildingType,
  CardType,
  SpellType,
  UnitType,
  type CardDefinition,
} from './types';

// Unit/building blueprint tables live in blueprintDefs.ts (split out 2026-08-12 — see that
// file's header comment — to keep this file under the server/ 500-line convention). Re-exported
// here so every existing `from './config'` import keeps resolving unchanged.
export { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from './blueprintDefs';

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
export const INK_CAP = 100;
export const BASE_UPGRADE_COSTS = [30, 70] as const;
export const BASE_UPGRADE_REGEN_BONUS = 1; // +1 ink/s per upgrade level, NOT scaled by acceleration (see ResourceSystem)

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
