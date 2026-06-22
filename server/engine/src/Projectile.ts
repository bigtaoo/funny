import { toFp, type Fp } from './math/fixed';
import { Side } from './types';

// Projectiles take the highest id range (2,000,000+). Buildings (0–999),
// units (1000+) and escorts (5000+) never reach it, so projectile ids can ride
// in GameEvents alongside the others without ever colliding.
let nextId = 2_000_000;

/**
 * Reset the projectile id counter. Called once per game (GameState constructor)
 * so ids are reproducible across engine instances — required for deterministic
 * replay verification (same seed ⇒ identical id stream).
 */
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
  ) {
    this.id         = nextId++;
    this.x_fp       = startCol_fp;
    this.y_fp       = startRow_fp;
    this.speed_fp   = toFp(speedGridPerSec); // grid/s → fp/s (same convention as Unit.speed_fp)
    this.targetId   = targetId;
    this.targetKind = targetKind;
    this.payload    = payload;
    this.kind       = kind;
  }
}
