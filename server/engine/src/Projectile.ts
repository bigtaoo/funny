import { toFp, type Fp } from './math/fixed';
import { Side } from './types';

// Real match spawns get their id from the owning GameState's per-instance counter
// (GameState.allocProjectileId, range 2,000,000+). This module-level counter is ONLY
// a fallback for standalone construction that has no owning GameState — i.e. tests.
//
// ⚠️ It must NOT be shared as the live-match id source: a second GameState built
// mid-match (e.g. judgeRunner's hash recompute) used to reset a shared global back to
// 2,000,000, so the live engine's next projectile reused a still-live id — the same
// ghost-entity bug fixed for Unit/Building ids (see GameState._nextUnitId). Hence the
// counter now lives on GameState, per instance.
let nextId = 2_000_000;

/** Reset the standalone/test-only projectile id fallback (see above). Not used by real matches. */
export function resetProjectileIds(): void {
  nextId = 2_000_000;
}

/** Which entity collection the homing target id lives in. */
export type ProjectileTargetKind = 'unit' | 'building' | 'escort';

/**
 * The attack snapshot a projectile carries from launch to impact. Damage (and any
 * crit) is rolled at fire time and frozen here, so the hit lands exactly as it
 * would have at launch — the projectile only adds travel time, not new RNG. The
 * offensive-trait fields let a future ranged unit (e.g. a splash mage) resolve
 * splash/pierce/slow/lifesteal at the impact point; archers/towers leave them inert.
 */
export interface ProjectilePayload {
  /** Firing entity id — used for unit_attack_hit.unitId and to find the live
   *  attacker for lifesteal at impact (skipped if it died mid-flight). */
  attackerId: number;
  /** Attacker's side — used to skip allies in splash/pierce. */
  side: Side;
  /** Pre-rolled damage (crit already applied). */
  rawDamage: number;
  splashRadius: number;
  piercing: boolean;
  lifestealPct: number;
  slowOnHit: { mult: number; durationTicks: number } | null;
  burstOnSingle: boolean;
  markEnemies: boolean;
}

/**
 * A homing projectile in flight. Tracks its target by id and steps toward the
 * target's current position each tick (CombatSystem.tickProjectiles), resolving
 * damage on arrival. If the target vanishes first, the projectile fizzles.
 *
 * Pure fixed-point state — no floats, no RNG — so it is fully deterministic.
 */
export class Projectile {
  readonly id: number;
  /** Continuous column position in fp (col × 1000). */
  x_fp: Fp;
  /** Continuous row position in fp (row × 1000). */
  y_fp: Fp;
  /** Flight speed in fp/second; combined with TICK_DT_FP for per-tick step. */
  readonly speed_fp: Fp;
  readonly targetId: number;
  readonly targetKind: ProjectileTargetKind;
  readonly payload: ProjectilePayload;
  readonly kind: string;

  constructor(
    startCol_fp: Fp,
    startRow_fp: Fp,
    speedGridPerSec: number,
    targetId: number,
    targetKind: ProjectileTargetKind,
    payload: ProjectilePayload,
    kind: string,
    // Explicit id from the owning GameState (GameState.allocProjectileId). Omitted only
    // by standalone construction (tests), which falls back to the module counter.
    id?: number,
  ) {
    this.id         = id ?? nextId++;
    this.x_fp       = startCol_fp;
    this.y_fp       = startRow_fp;
    this.speed_fp   = toFp(speedGridPerSec); // grid/s → fp/s (same convention as Unit.speed_fp)
    this.targetId   = targetId;
    this.targetKind = targetKind;
    this.payload    = payload;
    this.kind       = kind;
  }
}
