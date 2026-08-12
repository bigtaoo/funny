// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Data blueprints (immutable, not runtime state): trait/projectile specs, unit/building
// blueprints, and card definitions.
import type { UnitType, BuildingType, SpellType, CardType } from './enums';
import type { Fp } from '../math/fixed';

// i18n display keys are plain strings inside the engine — the simulation never
// resolves them. The render/UI layer (client) re-narrows them to TranslationKey
// and owns the i18n completeness check. See SLG_DESIGN §16.7 koan #2.
type TranslationKey = string;

// ─── Trait system (§4.4b–c) ──────────────────────────────────────────────────

/** Extensible slot-based trait descriptors (aura effects, etc.). */
export type TraitSpec =
  | { type: 'aura_heal'; radius: number; hps: number };

/**
 * Projectile spec (ranged attacks). When present on a unit/building blueprint,
 * an attack no longer applies instant damage — it spawns a homing projectile
 * that travels at `speed` grid/s and resolves damage when it reaches the target
 * (CombatSystem.tickProjectiles). Absent ⇒ instant melee-style hit (unchanged).
 */
export interface ProjectileSpec {
  /** Flight speed in grid cells/second (converted to fp/tick in the constructor). */
  speed: number;
  /** Visual kind key — the render layer narrows it to a sprite (e.g. 'arrow'). */
  kind: string;
}

export interface UnitBlueprint {
  type: UnitType;
  /**
   * ADR-065: continuous combat-balance fields on this interface are fixed-point
   * (`Fp`, scale = FP_SCALE = 1000), baked once in `balance/pveUpgrades.ts`'s
   * `buildPvpBlueprints`/`buildCampaignBlueprints`/`buildSiegeBlueprints` from
   * `config.ts`'s human-authored real-unit tables. Discrete grid-cell/tick counts
   * (`range`, `spawnCount`, `splashRadius`, `attackInterval`, `speed`) are NOT part
   * of this — they keep their existing pre-ADR-065 conventions (see field comments).
   */
  hp_fp: Fp;
  attack_fp: Fp;
  attackInterval: number; // seconds — converted to ticks in Unit constructor
  speed: number;          // grid/s  — converted to fp   in Unit constructor
  range: number;          // attack range in grid cells (1 = melee)
  spawnCount: number;     // units spawned per card play
  /** Collision radius in pre-scaled fixed-point (e.g. 400 = 0.4 grid). */
  radius_fp: number;
  /**
   * siege value — base HP a unit knocks off the enemy base when it reaches
   * it (MovementSystem). A first-class attribute at the same tier as attack / speed
   * (ADR-026, owner decision 2026-07-02): deliberately decoupled from `attack` (combat
   * DPS) so a unit's siege efficiency is an independent balance lever. PvP reads this
   * constant directly (hard wall); campaign/siege scale it through progression
   * (applyUnitLevels). Mirror of `siegeValueBase` in @nw/shared cards for the six
   * progression heroes — the two MUST stay in sync (that mirror stays real-unit; only
   * this engine-side field is fp per ADR-065).
   */
  siegeValue_fp: Fp;

  // ── Ranged attack (projectile) ─────────────────────────────────────────────
  /** Ranged units fire a homing projectile instead of dealing instant damage. */
  projectile?: ProjectileSpec;

  // ── Flying system (§4.4b) ──────────────────────────────────────────────────
  flying?: boolean;
  canTargetFlying?: boolean;   // archers = true; melee = false

  // ── Defensive traits ───────────────────────────────────────────────────────
  armor_fp?: Fp;                 // flat damage reduction per hit (min 1 damage)
  taunt?: boolean;              // enemy findTarget prefers this unit
  undying?: boolean;            // survive first lethal hit at 1 HP (PvE)
  berserkerThreshold_fp?: Fp;   // HP fraction 0–1 (fp); attack speed ×1.5 when HP < threshold
  /**
   * HP fraction 0–1 (fp); when current HP falls below this, `armorEnrageBonus_fp` is added to
   * effective armor (ShieldBearer T9 progression trait, ECONOMY_NUMBERS §4.4). Same "HP-threshold
   * → dynamic getter" shape as `berserkerThreshold_fp`, applied to armor instead of attack speed.
   */
  armorEnrageThreshold_fp?: Fp;
  armorEnrageBonus_fp?: Fp;    // flat armor added while below armorEnrageThreshold_fp
  /** 0–100 points (fp); % of actual damage dealt reflected back onto the attacker on hit (Lena T9 progression trait, same 0–100 convention as lifestealPct_fp). Defensive trait: read from the *target's* blueprint, not carried in ProjectilePayload. */
  reflectPct_fp?: Fp;

  // ── Offensive traits (PvE) ────────────────────────────────────────────────
  onDeathSpawn?: { type: UnitType; count: number };
  /** Crit chance 0–100 points (fp); on a roll under it, damage ×critMult (unit progression T3). 0/undefined = no crit. */
  critPct_fp?: Fp;
  /** Crit damage multiplier when a crit lands (fp; default = toFp(1) = no bonus). */
  critMult_fp?: Fp;
  splashRadius?: number;        // Chebyshev radius of splash damage (0 = no splash)
  piercing?: boolean;           // hit all enemies in same column
  slowOnHit?: { mult_fp: Fp; durationSec: number };

  // ── Sustain traits (PvE) ──────────────────────────────────────────────────
  regenPerSec?: number;
  lifestealPct_fp?: Fp;        // 0–100 points (fp); heal self by % of damage dealt
  traits?: TraitSpec[];

  // ── Special traits (PvE) ──────────────────────────────────────────────────
  stealth?: boolean;            // invisible to findTarget at Chebyshev dist > 2
  summonOnTimer?: { type: UnitType; intervalSec: number };

  // ── Anna-side unit traits (A6) ────────────────────────────────────────────
  /** 2× damage when only one live enemy remains on target side (Max). */
  burstOnSingle?: boolean;
  /** Multiplier applied by burstOnSingle (fp; default = toFp(2) when burstOnSingle is set but this is absent). Max T9 progression trait bumps this to toFp(2.5). */
  burstOnSingleMult_fp?: Fp;
  /** Marks the target on hit; marked units take +25 % damage from all sources for 3 s (Mara). */
  markEnemies?: boolean;
}

export interface BuildingBlueprint {
  type: BuildingType;
  hp_fp: Fp;
  attack_fp?: Fp;
  attackInterval?: number;  // seconds — converted to ticks in Building constructor
  attackRange?: number;     // grid cells forward
  spawnUnit?: UnitType;     // barracks only
  spawnInterval?: number;   // seconds — converted to ticks in Building constructor
  canTargetFlying?: boolean;
  /** Ranged defenders (arrow tower) fire a homing projectile instead of instant damage. */
  projectile?: ProjectileSpec;
  /** Flat damage reduction per hit; absorbed damage minimum 1. */
  armor_fp?: Fp;
}

export interface CardDefinition {
  id: string;
  /** i18n key for the display name — render layer resolves it via t() */
  nameKey: TranslationKey;
  /** i18n key for the card description (reserved for deck screen / detail popup) */
  descKey: TranslationKey;
  cardType: CardType;
  cost: number;
  unitType?: UnitType;
  buildingType?: BuildingType;
  spellType?: SpellType;
}
