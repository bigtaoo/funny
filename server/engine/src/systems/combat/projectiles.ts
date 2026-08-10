// Split from CombatSystem.ts (2026-08-10, independent function module range 6).
// Ranged-attack projectile lifecycle: spawn, per-tick homing advance, impact
// resolution. `tickProjectiles` calls back into hitResolution.ts on impact —
// hitResolution.ts calls back into `fireProjectile` here for ranged attackers,
// a natural pairing (spawn ↔ resolve), not a circular-import concern since both
// directions land on named function exports, not a re-export of each other.
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { Building } from '../../Building';
import { EscortUnit } from '../../EscortUnit';
import { Projectile, type ProjectilePayload, type ProjectileTargetKind } from '../../Projectile';
import { addFp, fp, fromFp, isqrt, mulFp, toFp, TICK_DT_FP, type Fp } from '../../math/fixed';
import { resolveAttackHit } from './hitResolution';

function targetRef(target: Unit | Building | EscortUnit): { targetId: number; targetKind: ProjectileTargetKind } {
  if (target instanceof Unit)     return { targetId: target.id,        targetKind: 'unit' };
  if (target instanceof Building) return { targetId: target.id,        targetKind: 'building' };
  return                                 { targetId: target.numericId, targetKind: 'escort' };
}

/** Spawn a homing projectile carrying `payload`, and emit projectile_fired. */
export function fireProjectile(
  state: GameState,
  startCol_fp: Fp,
  startRow_fp: Fp,
  spec: { speed: number; kind: string },
  target: Unit | Building | EscortUnit,
  payload: ProjectilePayload,
): void {
  const { targetId, targetKind } = targetRef(target);
  const proj = new Projectile(startCol_fp, startRow_fp, spec.speed, targetId, targetKind, payload, spec.kind, state.allocProjectileId());
  state.projectiles.push(proj);
  state.pushEvent({
    type:         'projectile_fired',
    projectileId: proj.id,
    attackerId:   payload.attackerId,
    from:         { col: Math.round(fromFp(startCol_fp)), y_fp: startRow_fp },
    kind:         spec.kind,
  });
}

/** Resolve a projectile's homing target to the live entity, or null if it is gone. */
function resolveProjectileTarget(proj: Projectile, state: GameState): Unit | Building | EscortUnit | null {
  if (proj.targetKind === 'unit') {
    const u = state.board.units.get(proj.targetId);
    return u && !u.isDead ? u : null;
  }
  if (proj.targetKind === 'building') {
    const b = state.board.buildings.get(proj.targetId);
    return b && !b.isDead ? b : null;
  }
  const e = state.escorts.find((esc) => esc.numericId === proj.targetId);
  return e && e.status === 'moving' ? e : null;
}

/**
 * Advance every in-flight projectile one tick toward its (moving) target. On
 * arrival it resolves its frozen payload (damage + traits) exactly as a melee
 * hit would; if its target vanished first it fizzles. Pure fixed-point homing
 * — deterministic, no RNG.
 */
export function tickProjectiles(state: GameState): void {
  if (state.projectiles.length === 0) return;

  const survivors: Projectile[] = [];
  for (const proj of state.projectiles) {
    const target = resolveProjectileTarget(proj, state);
    if (!target) {
      state.pushEvent({ type: 'projectile_expired', projectileId: proj.id });
      continue;
    }

    // Target's current fixed-point centre.
    let tx: Fp, ty: Fp;
    if (target instanceof Unit) {
      tx = target.x_fp; ty = target.y_fp;
    } else if (target instanceof Building) {
      tx = toFp(target.col); ty = toFp(target.row);
    } else {
      tx = target.col_fp; ty = target.row_fp;
    }

    const dx   = tx - proj.x_fp;
    const dy   = ty - proj.y_fp;
    const dist = isqrt(dx * dx + dy * dy);       // fp distance to target
    const step = mulFp(proj.speed_fp, TICK_DT_FP); // fp travelled this tick

    if (dist === 0 || dist <= step) {
      // Impact: resolve the frozen payload at the target, then retire the arrow.
      resolveAttackHit(state, proj.payload, target);
      state.pushEvent({ type: 'projectile_hit', projectileId: proj.id });
      continue;
    }

    // Move toward the target by `step`, scaling the direction with integer-exact
    // arithmetic (dx·step/dist keeps fp scale; trunc keeps it deterministic).
    proj.x_fp = addFp(proj.x_fp, fp(Math.trunc((dx * step) / dist)));
    proj.y_fp = addFp(proj.y_fp, fp(Math.trunc((dy * step) / dist)));
    state.pushEvent({ type: 'projectile_moved', projectileId: proj.id, col_fp: proj.x_fp, y_fp: proj.y_fp });
    survivors.push(proj);
  }
  state.projectiles = survivors;
}
