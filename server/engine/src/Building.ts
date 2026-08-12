import { toFp, subFp, maxFp, minFp, TICK_RATE, type Fp } from './math/fixed';
import { BUILDING_BLUEPRINTS } from './config';
import { BuildingBlueprint, BuildingType, Side, Vec2_fp } from './types';

// Real match placements get their id from the owning GameState's per-instance counter
// (GameState.allocBuildingId, range 0+). This module-level counter is ONLY a fallback
// for standalone construction that has no owning GameState — i.e. unit tests / tools.
//
// ⚠️ It must NOT be shared as the live-match id source: a second GameState built
// mid-match (e.g. judgeRunner's hash-recompute) used to reset a shared global back to
// 0, so the live engine's next placement (a player dropping an Arrow Tower) reused a
// still-live id and clobbered it in board.buildings (Map keyed by id — see
// Board.addBuilding). The overwritten building vanished from the Map that
// BuildingProductionSystem/CombatSystem iterate but stayed stamped in buildingGrid,
// leaving an orphaned "ghost" building: never ticked, yet still blocking its cell.
// Hence the counter now lives on GameState, per instance.
//
// The fallback starts well above the per-instance range (but still <1000) so a test
// that mixes standalone buildings with GameState-placed buildings on one board can
// never collide. Buildings keep the low id range (<1000, capped by board cells);
// units take the upper range (≥1000), so the two namespaces never overlap.
let nextId = 500;

/** Reset the standalone/test-only building id fallback (see above). Not used by real matches. */
export function resetBuildingIds(): void {
  nextId = 500;
}

export class Building {
  readonly id: number;
  readonly buildingType: BuildingType;
  readonly side: Side;
  readonly col: number;
  readonly row: number;

  hp_fp: Fp;
  readonly maxHp_fp: Fp;
  readonly attack_fp: Fp;
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

  /** Flat damage reduction per hit (fp); absorbed damage minimum toFp(1). ADR-065. */
  readonly armor_fp: Fp;

  constructor(
    buildingType: BuildingType,
    side: Side,
    col: number,
    row: number,
    blueprint: BuildingBlueprint = BUILDING_BLUEPRINTS[buildingType],
    // Explicit id from the owning GameState (GameState.allocBuildingId). Omitted only by
    // standalone construction (tests/tools), which falls back to the module counter.
    id?: number,
  ) {
    this.id           = id ?? nextId++;
    this.buildingType = buildingType;
    this.side         = side;
    this.col          = col;
    this.row          = row;

    const bp = blueprint;
    this.hp_fp             = bp.hp_fp;
    this.maxHp_fp          = bp.hp_fp;
    this.attack_fp         = bp.attack_fp ?? toFp(0);
    this.attackRange      = bp.attackRange ?? 0;
    this.canTargetFlying  = bp.canTargetFlying ?? false;
    this.armor_fp          = bp.armor_fp ?? toFp(0);
    this.projectile       = bp.projectile
      ? { speed: bp.projectile.speed, kind: bp.projectile.kind }
      : null;

    // Convert seconds → ticks (integer, no float retained after construction)
    this.attackIntervalTicks = bp.attackInterval !== undefined
      ? Math.round(bp.attackInterval * TICK_RATE)
      : Infinity;
  }

  get isDead(): boolean {
    return this.hp_fp <= 0;
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
  takeDamage(amount: Fp): Fp {
    const effective = this.armor_fp > 0 ? maxFp(toFp(1), subFp(amount, this.armor_fp)) : amount;
    const actual = minFp(this.hp_fp, effective);
    this.hp_fp = maxFp(toFp(0), subFp(this.hp_fp, effective));
    return actual;
  }
}
