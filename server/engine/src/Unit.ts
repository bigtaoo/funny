import { fp, FP_SCALE, fromFp, toFp, TICK_RATE, type Fp } from './math/fixed';
import { UNIT_BLUEPRINTS } from './config';
import { Side, UnitState, UnitType, type TraitSpec, type UnitBlueprint } from './types';

// Units are the high-volume entity (continuous spawning), so they take the upper
// id range starting at 1000. Buildings start at 0 and — capped by board cells —
// never reach 1000, so the two id namespaces can never collide.
let nextId = 1000;

/**
 * Reset the unit id counter. Called once per game (GameState constructor) so that
 * entity ids are reproducible across engine instances — required for deterministic
 * replay verification (same seed ⇒ identical id stream).
 */
export function resetUnitIds(): void {
  nextId = 1000;
}

export class Unit {
  readonly id: number;
  readonly unitType: UnitType;
  readonly side: Side;

  // ── Fixed-point position ──────────────────────────────────────────────────

  /** Continuous horizontal position in fp (col × 1000). Updated every tick during Crossing. */
  x_fp: Fp;

  /** Authoritative position along the lane in fp (row × 1000). */
  y_fp: Fp;

  /** Integer column index — snapped from x_fp. Use colExact for smooth rendering. */
  col: number;

  /** Collision radius in fp. Two units don't overlap when radii don't intersect. */
  readonly radius_fp: Fp;

  // ── Stats ──────────────────────────────────────────────────────────────────

  hp: number;
  readonly maxHp: number;
  readonly attack: number;

  /**
   * Attack interval in integer ticks.
   * Converted from seconds at construction: Math.round(attackInterval_s * TICK_RATE).
   */
  readonly attackIntervalTicks: number;

  /** Attack range in integer grid cells (1 = melee). */
  readonly range: number;

  /** Current speed in fp/tick (may be modified by Haste spell or slow). */
  speed_fp: Fp;
  /** Base speed before modifiers, in fp/tick. */
  readonly baseSpeed_fp: Fp;

  // ── Runtime state ──────────────────────────────────────────────────────────

  state: UnitState = UnitState.Moving;

  /**
   * Ticks remaining until the next attack is ready.
   * Decremented each tick in CombatSystem. Attack fires when it reaches 0.
   */
  attackCooldownTicks: number = 0;

  /** ID of the current attack target (unit or building), or null. */
  targetId: number | null = null;

  /** Whether this unit is a scripted boss (campaign `boss` objective). */
  isBoss: boolean = false;

  /**
   * While Crossing, true if blocked by a friendly unit ahead this tick.
   * Used to require a full-footprint gap before resuming movement,
   * avoiding rapid Moving/Waiting flapping.
   */
  crossingBlocked: boolean = false;

  // ── Detour (MidCross) ─────────────────────────────────────────────────────

  /** Target column for the current Detour (crossWaypoint or blocked auto-detour). Null when not detouring. */
  detourTargetCol: number | null = null;
  /** Lateral direction of travel during Detour: +1 right, -1 left, 0 not yet assigned. */
  detourDir: 1 | -1 | 0 = 0;
  /** Pending crossWaypoint triggers for this unit, sorted by atRow (ascending for Bottom, descending for Top). */
  pendingWaypoints: { atRow: number; toCol: number }[] = [];

  // ── Hazard modifiers (reset each tick by HazardSystem) ───────────────────

  /** Additive range modifier applied by fog hazards. Negative = reduced range. Reset to 0 each tick. */
  rangeMod: number = 0;

  // ── Blueprint-derived trait data (§4.4b–c) ────────────────────────────────

  /** Flying units bypass blocked cells and don't collide with ground units. */
  readonly flying: boolean;
  /** Unit can target flying enemies (archers = true, melee = false). */
  readonly canTargetFlying: boolean;
  /** Flat damage reduction per hit; absorbed damage minimum 1. */
  readonly armor: number;
  /** Enemy findTarget prefers this unit as the attack target. */
  readonly taunt: boolean;
  /** Survive first lethal hit with 1 HP; flag cleared after use (PvE). */
  readonly undying: boolean;
  /** HP fraction 0–1; attack speed ×1.5 when HP < threshold. 0 = disabled. */
  readonly berserkerThreshold: number;
  /** Spawn N units of given type on death (PvE). */
  readonly onDeathSpawn: { type: UnitType; count: number } | null;
  /** Chebyshev radius of bonus splash damage applied around the primary target. 0 = no splash. */
  readonly splashRadius: number;
  /** Hit all enemies in the same column on each attack (PvE). */
  readonly piercing: boolean;
  /** Slow attacker-target speed on hit: mult × baseSpeed for durationTicks (PvE). */
  readonly slowOnHit: { mult: number; durationTicks: number } | null;
  /** HP regen in fp/tick (accumulated into healAccFp). 0 = no regen. */
  readonly regenFpPerTick: number;
  /** Heal self by this % of damage dealt to Units. 0 = no lifesteal. */
  readonly lifestealPct: number;
  /** Extensible trait descriptors (e.g. aura_heal). */
  readonly traits: readonly TraitSpec[];
  /** Invisible to findTarget at Chebyshev dist > 2 (PvE). */
  readonly stealth: boolean;
  /** Periodically summon units of given type; intervalTicks between spawns. */
  readonly summonOnTimer: { type: UnitType; intervalTicks: number } | null;

  // ── Runtime trait state ────────────────────────────────────────────────────

  /** Set to true after undying triggers; prevents repeat activation. */
  undyingTriggered: boolean = false;
  /** Ticks remaining for current slow effect. 0 = not slowed. */
  slowRemainingTicks: number = 0;
  /** Countdown until next summonOnTimer spawn. Set to intervalTicks on construction. */
  summonCooldownTicks: number = 0;
  /** Fractional HP accumulator for regen and aura_heal (fp units = 1/1000 HP). */
  healAccFp: number = 0;

  /**
   * @param blueprint Resolved stats for this unit. Defaults to the read-only PvP
   *   constant; the engine injects state.unitBlueprints[unitType] so PvE upgrades
   *   apply only on the campaign path (hard wall, §5.2). Tests that construct a
   *   Unit directly get the default PvP stats.
   * @param initialHp SLG siege battle (G3, §16.1, "兵力 = 血量"): override the unit's
   *   starting HP with the allotted troops. Clamped to the blueprint's full HP
   *   capacity. Omitted → full blueprint HP. maxHp always stays the blueprint cap.
   */
  constructor(
    unitType: UnitType,
    side: Side,
    col: number,
    spawnRow: number,
    blueprint: UnitBlueprint = UNIT_BLUEPRINTS[unitType],
    initialHp?: number,
  ) {
    this.id        = nextId++;
    this.unitType  = unitType;
    this.side      = side;
    this.col       = col;
    this.x_fp      = toFp(col);
    this.y_fp      = toFp(spawnRow);

    const bp = blueprint;
    // 兵力 = 血量 (§16.1): allotted troops set starting HP, capped at the blueprint
    // full capacity. maxHp stays the cap so combat / regen / UI bars are unchanged.
    this.hp       = initialHp !== undefined ? Math.min(initialHp, bp.hp) : bp.hp;
    this.maxHp    = bp.hp;
    this.attack   = bp.attack;
    this.range    = bp.range;

    // Convert seconds → ticks (integer, no float retained)
    this.attackIntervalTicks = Math.round(bp.attackInterval * TICK_RATE);

    // radius_fp in blueprint is already a pre-scaled integer constant
    this.radius_fp = fp(bp.radius_fp);

    // Convert grid/s → fp/tick using only integer arithmetic:
    //   speed_fp_per_tick = round(speed_grid_per_s * FP_SCALE / TICK_RATE)
    this.speed_fp    = toFp(bp.speed); // toFp converts grid/s → fp (same scale for 1/tick at 1Hz)
    // Actually speed_fp here should be fp/s, and movement uses TICK_DT_FP to get fp/tick.
    // toFp(bp.speed) = bp.speed * 1000, which is fp/s — correct, MovementSystem uses mulFp(speed_fp, TICK_DT_FP).
    this.baseSpeed_fp = this.speed_fp;

    // ── Trait fields from blueprint ──────────────────────────────────────────
    this.flying          = bp.flying          ?? false;
    this.canTargetFlying = bp.canTargetFlying ?? false;
    this.armor           = bp.armor           ?? 0;
    this.taunt           = bp.taunt           ?? false;
    this.undying         = bp.undying         ?? false;
    this.berserkerThreshold = bp.berserkerThreshold ?? 0;
    this.onDeathSpawn    = bp.onDeathSpawn    ?? null;
    this.splashRadius    = bp.splashRadius    ?? 0;
    this.piercing        = bp.piercing        ?? false;
    this.slowOnHit       = bp.slowOnHit
      ? { mult: bp.slowOnHit.mult, durationTicks: Math.round(bp.slowOnHit.durationSec * TICK_RATE) }
      : null;
    this.regenFpPerTick  = bp.regenPerSec
      ? Math.round(bp.regenPerSec * FP_SCALE / TICK_RATE)
      : 0;
    this.lifestealPct    = bp.lifestealPct    ?? 0;
    this.traits          = bp.traits          ?? [];
    this.stealth         = bp.stealth         ?? false;
    this.summonOnTimer   = bp.summonOnTimer
      ? { type: bp.summonOnTimer.type, intervalTicks: Math.round(bp.summonOnTimer.intervalSec * TICK_RATE) }
      : null;
    this.summonCooldownTicks = this.summonOnTimer?.intervalTicks ?? 0;
  }

  // ── Derived / compatibility getters ───────────────────────────────────────

  /** Integer grid row (snapped from fp position). */
  get row(): number {
    return Math.round(this.y_fp / FP_SCALE);
  }

  /**
   * Fractional grid row for rendering (float).
   * RENDER ONLY — never use in game logic.
   */
  get rowExact(): number {
    return fromFp(this.y_fp);
  }

  /**
   * Fractional grid column for rendering (float).
   * Equals col during normal movement; interpolates smoothly during Crossing.
   * RENDER ONLY — never use in game logic.
   */
  get colExact(): number {
    return fromFp(this.x_fp);
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  /** Attack range taking fog-hazard reduction into account. Always >= 1. */
  get effectiveRange(): number {
    return Math.max(1, this.range + this.rangeMod);
  }

  /**
   * Attack interval after berserker modifier.
   * ×1.5 speed = ÷1.5 interval when HP < berserkerThreshold fraction.
   */
  get effectiveAttackIntervalTicks(): number {
    if (this.berserkerThreshold > 0 && this.hp < this.maxHp * this.berserkerThreshold) {
      return Math.max(1, Math.round(this.attackIntervalTicks * 2 / 3));
    }
    return this.attackIntervalTicks;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  /**
   * Apply damage to this unit, accounting for armor and undying.
   * Returns the actual HP lost (after armor reduction, capped to current HP).
   */
  takeDamage(rawAmount: number): number {
    const effective = this.armor > 0 ? Math.max(1, rawAmount - this.armor) : rawAmount;

    // Undying: survive first lethal hit at 1 HP.
    if (this.undying && !this.undyingTriggered && this.hp - effective <= 0) {
      const lost = this.hp - 1;
      this.hp = 1;
      this.undyingTriggered = true;
      return Math.max(0, lost);
    }

    const actual = Math.min(this.hp, effective);
    this.hp = Math.max(0, this.hp - effective);
    if (this.hp === 0) this.state = UnitState.Dead;
    return actual;
  }

  resetSpeed(): void {
    this.speed_fp = this.baseSpeed_fp;
  }
}
