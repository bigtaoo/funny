// Split from CombatSystem.ts (2026-08-10, independent function module range 6).
// Attack execution (crit roll + payload snapshot) and the shared hit-resolution
// pipeline (primary damage + lifesteal/slow/splash/piercing/reflect) — the two
// heaviest pieces of the file, both pure functions of GameState + explicit args.
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { Building } from '../../Building';
import { EscortUnit } from '../../EscortUnit';
import { type ProjectilePayload } from '../../Projectile';
import { fp, toFp } from '../../math/fixed';
import { fireProjectile } from './projectiles';

export function performUnitAttack(
  attacker: Unit,
  target: Unit | Building | EscortUnit,
  state: GameState,
  attackMult: number,
): void {
  // Crit roll (unit progression T3): deterministic PRNG roll under critPct → ×critMult.
  // critPct is 0 for all PvP units, so combatPrng never advances in PvP — existing
  // PvP replays stay bit-identical. Crit boosts rawDamage, so splash/pierce/lifesteal
  // (all derived from rawDamage/actualDamage below) inherit the crit consistently.
  let rawDamage = attacker.attack * attackMult;
  if (attacker.critPct > 0 && state.combatPrng.nextInt(100) < attacker.critPct) {
    rawDamage = Math.round(rawDamage * attacker.critMult);
  }

  // Snapshot the hit payload at fire time (crit + traits frozen). Ranged units
  // launch a projectile that resolves this exact payload on impact; melee units
  // resolve it immediately (identical events to the pre-projectile behaviour).
  const payload: ProjectilePayload = {
    attackerId:    attacker.id,
    side:          attacker.side,
    rawDamage,
    splashRadius:  attacker.splashRadius,
    piercing:      attacker.piercing,
    lifestealPct:  attacker.lifestealPct,
    slowOnHit:     attacker.slowOnHit,
    burstOnSingle: attacker.burstOnSingle,
    burstOnSingleMult: attacker.burstOnSingleMult,
    markEnemies:   attacker.markEnemies,
  };

  if (attacker.projectile) {
    fireProjectile(state, attacker.x_fp, attacker.y_fp, attacker.projectile, target, payload);
  } else {
    resolveAttackHit(state, payload, target);
  }
}

export function performBuildingAttack(
  building: Building,
  target: Unit,
  state: GameState,
  attackMult: number,
): void {
  // Buildings carry no offensive traits — a plain damage payload.
  const payload: ProjectilePayload = {
    attackerId:    building.id,
    side:          building.side,
    rawDamage:     building.attack * attackMult,
    splashRadius:  0,
    piercing:      false,
    lifestealPct:  0,
    slowOnHit:     null,
    burstOnSingle: false,
    burstOnSingleMult: 2,
    markEnemies:   false,
  };

  if (building.projectile) {
    fireProjectile(state, toFp(building.col), toFp(building.row), building.projectile, target, payload);
  } else {
    resolveAttackHit(state, payload, target);
  }
}

/**
 * Apply a (frozen) attack payload to a live target: primary damage + events,
 * then lifesteal / slow / splash / piercing. Called immediately for melee, and
 * at impact for projectiles. Event order matches the original inline melee path
 * exactly, so existing melee replays stay bit-identical.
 */
export function resolveAttackHit(
  state: GameState,
  payload: ProjectilePayload,
  target: Unit | Building | EscortUnit,
): void {
  let rawDamage = payload.rawDamage;

  // burstOnSingle (Max): ×burstOnSingleMult damage (default 2, T9 progression bumps to 2.5)
  // when only one live enemy remains on target side.
  if (payload.burstOnSingle && target instanceof Unit) {
    let liveCount = 0;
    for (const u of state.board.units.values()) {
      if (!u.isDead && u.side === target.side) { liveCount++; if (liveCount > 1) break; }
    }
    if (liveCount === 1) rawDamage = rawDamage * payload.burstOnSingleMult;
  }

  // markEnemies (Mara): +25 % bonus damage on a marked target.
  if (target instanceof Unit && target.markedTicks > 0) {
    rawDamage = Math.round(rawDamage * 1.25);
  }

  // Apply damage to primary target; capture actual HP lost (after armor) for lifesteal + events.
  let actualDamage: number;
  if (target instanceof Unit) {
    actualDamage = target.takeDamage(rawDamage);
  } else if (target instanceof Building) {
    actualDamage = target.takeDamage(rawDamage);
  } else {
    target.takeDamage(rawDamage);
    actualDamage = rawDamage;
  }

  if (target instanceof EscortUnit) {
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            payload.attackerId,
      targetId:          target.numericId,
      damage:            actualDamage,
      targetHpRemaining: target.hp,
    });
    state.pushEvent({
      type:     'escort_hp_changed',
      escortId: target.id,
      hp:       target.hp,
      maxHp:    target.maxHp,
    });
  } else {
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            payload.attackerId,
      targetId:          target.id,
      damage:            actualDamage,
      targetHpRemaining: target.hp,
    });

    if (target instanceof Building && !target.isDead) {
      state.pushEvent({
        type:       'building_hp_changed',
        buildingId: target.id,
        hp:         target.hp,
        maxHp:      target.maxHp,
      });
    }
  }

  // markEnemies (Mara): apply mark debuff after primary hit (3 s = 90 ticks at 30 Hz).
  if (payload.markEnemies && target instanceof Unit && !target.isDead) {
    target.markedTicks = 90;
  }

  // ── Offensive trait effects (applied after primary hit) ───────────────

  // Lifesteal: heal the firing unit by % of actual damage dealt — only if it is
  // still alive on the board (a projectile may outlive its archer).
  if (payload.lifestealPct > 0 && actualDamage > 0) {
    const attacker = state.board.units.get(payload.attackerId);
    if (attacker && !attacker.isDead) {
      const heal = Math.floor(actualDamage * payload.lifestealPct / 100);
      if (heal > 0) attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
    }
  }

  // Slow on hit: reduce target speed for N ticks (Units only).
  if (payload.slowOnHit && target instanceof Unit) {
    target.slowRemainingTicks = payload.slowOnHit.durationTicks;
    target.speed_fp = fp(Math.max(1, Math.round(target.baseSpeed_fp * payload.slowOnHit.mult)));
  }

  // Reflect (Lena T9 progression trait): a defensive trait read off the *target*, not the
  // attacker — unlike lifesteal/burstOnSingle/markEnemies above, which are all offensive
  // traits carried in the payload. Reflects a % of actual damage taken back onto whoever
  // fired (Unit or Building — arrow towers can be reflected onto too), through the normal
  // takeDamage()/armor pipeline so reflected damage is not itself armor-piercing.
  if (target instanceof Unit && target.reflectPct > 0 && actualDamage > 0 && !target.isDead) {
    const reflectDamage = Math.floor(actualDamage * target.reflectPct / 100);
    if (reflectDamage > 0) {
      const attackerUnit = state.board.units.get(payload.attackerId);
      if (attackerUnit && !attackerUnit.isDead) {
        attackerUnit.takeDamage(reflectDamage);
      } else {
        const attackerBuilding = state.board.buildings.get(payload.attackerId);
        if (attackerBuilding && !attackerBuilding.isDead) attackerBuilding.takeDamage(reflectDamage);
      }
    }
  }

  // Splash: deal rawDamage to enemies within splashRadius Chebyshev of the primary target.
  if (payload.splashRadius > 0 && target instanceof Unit) {
    const tRow = target.row;
    const tCol = target.col;
    for (const u of state.board.units.values()) {
      if (u === target || u.isDead || u.side === payload.side) continue;
      if (payload.splashRadius < Math.max(Math.abs(u.row - tRow), Math.abs(u.col - tCol))) continue;
      const splashActual = u.takeDamage(rawDamage);
      state.pushEvent({
        type:              'unit_attack_hit',
        unitId:            payload.attackerId,
        targetId:          u.id,
        damage:            splashActual,
        targetHpRemaining: u.hp,
      });
    }
  }

  // Piercing: hit all other enemies in the same column as the primary target.
  if (payload.piercing && target instanceof Unit) {
    const tCol = target.col;
    for (const u of state.board.units.values()) {
      if (u === target || u.isDead || u.side === payload.side) continue;
      if (u.col !== tCol) continue;
      const pierceActual = u.takeDamage(rawDamage);
      state.pushEvent({
        type:              'unit_attack_hit',
        unitId:            payload.attackerId,
        targetId:          u.id,
        damage:            pierceActual,
        targetHpRemaining: u.hp,
      });
    }
  }
}
