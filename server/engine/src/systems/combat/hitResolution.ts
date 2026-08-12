// Split from CombatSystem.ts (2026-08-10, independent function module range 6).
// Attack execution (crit roll + payload snapshot) and the shared hit-resolution
// pipeline (primary damage + lifesteal/slow/splash/piercing/reflect) — the two
// heaviest pieces of the file, both pure functions of GameState + explicit args.
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { Building } from '../../Building';
import { EscortUnit } from '../../EscortUnit';
import { type ProjectilePayload } from '../../Projectile';
import { fp, toFp, scaleFp, mulFp, divFpByInt, maxFp, minFp, addFp, type Fp } from '../../math/fixed';
import { fireProjectile } from './projectiles';

export function performUnitAttack(
  attacker: Unit,
  target: Unit | Building | EscortUnit,
  state: GameState,
  attackMult: number,
): void {
  // Crit roll (unit progression T3): deterministic PRNG roll under critPct_fp → ×critMult_fp.
  // critPct_fp is 0 for all PvP units, so combatPrng never advances in PvP — existing
  // PvP replays stay bit-identical. Crit boosts rawDamage, so splash/pierce/lifesteal
  // (all derived from rawDamage/actualDamage below) inherit the crit consistently.
  // ADR-065: attackMult is a plain safe-integer coefficient (1 or 2, ATTACK_MULT_LATE_GAME)
  // → scaleFp, not mulFp. The roll side (nextInt(100)) is scaled ×1000 to compare against the
  // fp critPct_fp WITHOUT truncating critPct_fp's precision and WITHOUT changing how many/which
  // PRNG draws happen (nextInt(100)'s range is unchanged — only the comparison threshold moved).
  let rawDamage: Fp = scaleFp(attackMult, attacker.attack_fp);
  if (attacker.critPct_fp > 0 && state.combatPrng.nextInt(100) * 1000 < attacker.critPct_fp) {
    rawDamage = mulFp(rawDamage, attacker.critMult_fp);
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
    lifestealPct:  attacker.lifestealPct_fp,
    slowOnHit:     attacker.slowOnHit,
    burstOnSingle: attacker.burstOnSingle,
    burstOnSingleMult: attacker.burstOnSingleMult_fp,
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
    rawDamage:     scaleFp(attackMult, building.attack_fp),
    splashRadius:  0,
    piercing:      false,
    lifestealPct:  toFp(0),
    slowOnHit:     null,
    burstOnSingle: false,
    burstOnSingleMult: toFp(2),
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
  let rawDamage: Fp = payload.rawDamage;

  // burstOnSingle (Max): ×burstOnSingleMult damage (default 2, T9 progression bumps to 2.5)
  // when only one live enemy remains on target side.
  if (payload.burstOnSingle && target instanceof Unit) {
    let liveCount = 0;
    for (const u of state.board.units.values()) {
      if (!u.isDead && u.side === target.side) { liveCount++; if (liveCount > 1) break; }
    }
    if (liveCount === 1) rawDamage = mulFp(rawDamage, payload.burstOnSingleMult);
  }

  // markEnemies (Mara): +25 % bonus damage on a marked target. 1.25 is a hardcoded literal
  // ratio (not a blueprint field) — toFp() at the call site.
  if (target instanceof Unit && target.markedTicks > 0) {
    rawDamage = mulFp(rawDamage, toFp(1.25));
  }

  // Apply damage to primary target; capture actual HP lost (after armor) for lifesteal + events.
  let actualDamage: Fp;
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
      type:                 'unit_attack_hit',
      unitId:               payload.attackerId,
      targetId:             target.numericId,
      damage_fp:            actualDamage,
      targetHpRemaining_fp: target.hp_fp,
    });
    state.pushEvent({
      type:     'escort_hp_changed',
      escortId: target.id,
      hp_fp:    target.hp_fp,
      maxHp_fp: target.maxHp_fp,
    });
  } else {
    state.pushEvent({
      type:                 'unit_attack_hit',
      unitId:               payload.attackerId,
      targetId:             target.id,
      damage_fp:            actualDamage,
      targetHpRemaining_fp: target.hp_fp,
    });

    if (target instanceof Building && !target.isDead) {
      state.pushEvent({
        type:       'building_hp_changed',
        buildingId: target.id,
        hp_fp:      target.hp_fp,
        maxHp_fp:   target.maxHp_fp,
      });
    }
  }

  // markEnemies (Mara): apply mark debuff after primary hit (3 s = 90 ticks at 30 Hz).
  if (payload.markEnemies && target instanceof Unit && !target.isDead) {
    target.markedTicks = 90;
  }

  // ── Offensive trait effects (applied after primary hit) ───────────────

  // Lifesteal: heal the firing unit by % of actual damage dealt — only if it is
  // still alive on the board (a projectile may outlive its archer). payload.lifestealPct
  // is fp points (0–100 scale); mulFp then ÷100 (divFpByInt) converts to an fp heal amount.
  if (payload.lifestealPct > 0 && actualDamage > 0) {
    const attacker = state.board.units.get(payload.attackerId);
    if (attacker && !attacker.isDead) {
      const heal_fp = divFpByInt(mulFp(actualDamage, payload.lifestealPct), 100);
      if (heal_fp > 0) attacker.hp_fp = minFp(attacker.maxHp_fp, addFp(attacker.hp_fp, heal_fp));
    }
  }

  // Slow on hit: reduce target speed for N ticks (Units only). mulFp replaces the old
  // hand-rolled Math.round(baseSpeed_fp × plain-decimal-mult) — same fp × fp domain now
  // that slowOnHit.mult is fp too (ADR-065).
  if (payload.slowOnHit && target instanceof Unit) {
    target.slowRemainingTicks = payload.slowOnHit.durationTicks;
    target.speed_fp = maxFp(fp(1), mulFp(target.baseSpeed_fp, payload.slowOnHit.mult_fp));
  }

  // Reflect (Lena T9 progression trait): a defensive trait read off the *target*, not the
  // attacker — unlike lifesteal/burstOnSingle/markEnemies above, which are all offensive
  // traits carried in the payload. Reflects a % of actual damage taken back onto whoever
  // fired (Unit or Building — arrow towers can be reflected onto too), through the normal
  // takeDamage()/armor pipeline so reflected damage is not itself armor-piercing.
  if (target instanceof Unit && target.reflectPct_fp > 0 && actualDamage > 0 && !target.isDead) {
    const reflectDamage = divFpByInt(mulFp(actualDamage, target.reflectPct_fp), 100);
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
        type:                 'unit_attack_hit',
        unitId:               payload.attackerId,
        targetId:             u.id,
        damage_fp:            splashActual,
        targetHpRemaining_fp: u.hp_fp,
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
        type:                 'unit_attack_hit',
        unitId:               payload.attackerId,
        targetId:             u.id,
        damage_fp:            pierceActual,
        targetHpRemaining_fp: u.hp_fp,
      });
    }
  }
}
