import { fp, FP_SCALE, fromFp, toFp, TICK_RATE, type Fp } from './math/fixed';
import { UNIT_BLUEPRINTS } from './config';
import { Side, UnitState, UnitType } from './types';

let nextId = 0;

export class Unit {
  readonly id: number;
  readonly unitType: UnitType;
  readonly side: Side;

  // Column index (integer, fixed for unit lifetime unless Crossing)
  col: number;

  // ── Fixed-point position ───────────────────────────────────────────────────

  /** Authoritative position along the lane in fp (row × 1000). */
  y_fp: Fp;

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

  /** Current speed in fp/tick (may be modified by Haste spell). */
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

  constructor(unitType: UnitType, side: Side, col: number, spawnRow: number) {
    this.id        = nextId++;
    this.unitType  = unitType;
    this.side      = side;
    this.col       = col;
    this.y_fp      = toFp(spawnRow);

    const bp = UNIT_BLUEPRINTS[unitType];
    this.hp       = bp.hp;
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

  get isDead(): boolean {
    return this.hp <= 0;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) this.state = UnitState.Dead;
  }

  resetSpeed(): void {
    this.speed_fp = this.baseSpeed_fp;
  }
}
