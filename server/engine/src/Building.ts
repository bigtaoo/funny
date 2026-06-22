import { toFp, TICK_RATE } from './math/fixed';
import { BUILDING_BLUEPRINTS } from './config';
import { BuildingBlueprint, BuildingType, Side, Vec2_fp } from './types';

// Buildings are few (capped by board cells, well under 1000) so they take the
// low id range starting at 0. Units start at 1000, so the namespaces never collide
// no matter how long the game runs.
let nextId = 0;

/**
 * Reset the building id counter. Called once per game (GameState constructor) so that
 * entity ids are reproducible across engine instances — required for deterministic
 * replay verification (same seed ⇒ identical id stream).
 */
export function resetBuildingIds(): void {
  nextId = 0;
}

export class Building {
  readonly id: number;
  readonly buildingType: BuildingType;
  readonly side: Side;
  readonly col: number;
  readonly row: number;

  hp: number;
  readonly maxHp: number;
  readonly attack: number;
  readonly attackRange: number;
  readonly canTargetFlying: boolean;
  /** Ranged defender: fire a homing projectile instead of instant damage. null = none. */
  readonly projectile: { speed: number; kind: string } | null;

  /**
   * Attack interval in integer ticks.
   * Converted from seconds at construction: Math.round(attackInterval_s * TICK_RATE).
   */
  readonly attackIntervalTicks: number;

  /**
   * Ticks remaining until next attack.
   * 0 = ready to attack immediately.
   */
  attackCooldownTicks: number = 0;

  /**
   * Ticks remaining until next unit spawn (barracks only).
   * 0 = spawns on the very first tick after placement.
   */
  spawnCooldownTicks: number = 0;

  /** Flat damage reduction per hit; absorbed damage minimum 1. */
  readonly armor: number;

  constructor(
    buildingType: BuildingType,
    side: Side,
    col: number,
    row: number,
    blueprint: BuildingBlueprint = BUILDING_BLUEPRINTS[buildingType],
  ) {
    this.id           = nextId++;
    this.buildingType = buildingType;
    this.side         = side;
    this.col          = col;
    this.row          = row;

    const bp = blueprint;
    this.hp               = bp.hp;
    this.maxHp            = bp.hp;
    this.attack           = bp.attack ?? 0;
    this.attackRange      = bp.attackRange ?? 0;
    this.canTargetFlying  = bp.canTargetFlying ?? false;
    this.armor            = bp.armor ?? 0;
    this.projectile       = bp.projectile
      ? { speed: bp.projectile.speed, kind: bp.projectile.kind }
      : null;

    // Convert seconds → ticks (integer, no float retained after construction)
    this.attackIntervalTicks = bp.attackInterval !== undefined
      ? Math.round(bp.attackInterval * TICK_RATE)
      : Infinity;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  get isBarracks(): boolean {
    return this.buildingType === BuildingType.Barracks;
  }

  get isDefender(): boolean {
    return this.buildingType === BuildingType.ArrowTower;
  }

  /** Fixed-point position (for events). */
  get pos(): Vec2_fp {
    return { col: this.col, y_fp: toFp(this.row) };
  }

  /**
   * Apply damage, accounting for armor (flat reduction, minimum 1 per hit).
   * Returns actual HP lost.
   */
  takeDamage(amount: number): number {
    const effective = this.armor > 0 ? Math.max(1, amount - this.armor) : amount;
    const actual = Math.min(this.hp, effective);
    this.hp = Math.max(0, this.hp - effective);
    return actual;
  }
}
