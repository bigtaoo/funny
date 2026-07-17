import { ATTACK_MULT_LATE_GAME, ATTACK_MULT_THRESHOLD_TICKS, BOARD_COLS, BOARD_ROWS, BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '../config';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Building } from '../Building';
import { EscortUnit } from '../EscortUnit';
import { Projectile, type ProjectilePayload, type ProjectileTargetKind } from '../Projectile';
import { addFp, fp, fromFp, isqrt, mulFp, toFp, TICK_DT_FP, type Fp } from '../math/fixed';
import { Side, UnitState } from '../types';

/**
 * CombatSystem — tick-based attack cooldowns, no floating-point.
 *
 * Direction convention:
 *   Bottom (+1): looks for targets at higher row numbers (rows above).
 *   Top    (-1): looks for targets at lower  row numbers (rows below).
 */
export class CombatSystem {
  tick(state: GameState): void {
    const board = state.board;

    const attackMult = state.elapsedTicks >= ATTACK_MULT_THRESHOLD_TICKS
      ? ATTACK_MULT_LATE_GAME
      : 1;

    // ── Units attack ───────────────────────────────────────────────────────
    for (const unit of board.units.values()) {
      if (unit.isDead || unit.state === UnitState.Crossing) continue;

      if (unit.attackCooldownTicks > 0) unit.attackCooldownTicks--;

      const target = this.findTarget(unit, state);
      if (target) {
        const targetId = target instanceof EscortUnit ? target.numericId : target.id;
        if (unit.state !== UnitState.Attacking) {
          state.pushEvent({ type: 'unit_attack_start', unitId: unit.id, targetId });
          unit.targetId = targetId;
          unit.state    = UnitState.Attacking;
        }
        if (unit.attackCooldownTicks === 0) {
          this.performUnitAttack(unit, target, state, attackMult);
          unit.attackCooldownTicks = unit.effectiveAttackIntervalTicks;
        }
      } else {
        if (unit.state === UnitState.Attacking) {
          unit.state    = UnitState.Moving;
          unit.targetId = null;
        }
      }
    }

    // ── Arrow towers attack ────────────────────────────────────────────────
    for (const building of board.buildings.values()) {
      if (building.isDead || !building.isDefender) continue;

      if (building.attackCooldownTicks > 0) building.attackCooldownTicks--;
      if (building.attackCooldownTicks === 0) {
        const target = this.findTargetForBuilding(building, state);
        if (target) {
          this.performBuildingAttack(building, target, state, attackMult);
          building.attackCooldownTicks = building.attackIntervalTicks;
        }
      }
    }

    // ── Advance projectiles & resolve impacts ────────────────────────────────
    // Runs after both fire loops (so this-tick shots advance once immediately)
    // and before dead removal (so arrow kills are cleaned up in the same tick,
    // identical to melee kills).
    this.tickProjectiles(state);

    // ── Remove dead units ──────────────────────────────────────────────────
    for (const unit of Array.from(board.units.values())) {
      if (unit.isDead) {
        // Credit kill to the opponent
        const killerOwner = state.ownerOf(unit.side === Side.Bottom ? Side.Top : Side.Bottom);
        state.stats[killerOwner].unitsKilled++;
        // Per-victim-type kill tally (S9-3b) — single removal site covers all killers (melee/arrow/spell).
        const km = state.stats[killerOwner].killsByType;
        km[unit.unitType] = (km[unit.unitType] ?? 0) + 1;

        state.pushEvent({ type: 'unit_died', unitId: unit.id, pos: { col: unit.col, y_fp: unit.y_fp } });

        // onDeathSpawn: spawn minions at the dead unit's position (PvE).
        if (unit.onDeathSpawn) {
          const spawnBp = state.unitBlueprints[unit.onDeathSpawn.type];
          for (let i = 0; i < unit.onDeathSpawn.count; i++) {
            const spawned = new Unit(unit.onDeathSpawn.type, unit.side, unit.col, unit.row, spawnBp, undefined, state.allocUnitId());
            board.addUnit(spawned);
            state.stats[state.ownerOf(unit.side)].unitsSent++;
            const destRow = unit.side === Side.Bottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
            state.pushEvent({
              type:      'unit_spawned',
              unitId:    spawned.id,
              owner:     state.ownerOf(unit.side),
              unitType:  spawned.unitType,
              col:       spawned.col,
              y_fp:      spawned.y_fp,
              radius_fp: spawned.radius_fp,
            });
            state.pushEvent({
              type:     'unit_move_start',
              unitId:   spawned.id,
              from:     { col: spawned.col, y_fp: spawned.y_fp },
              to:       { col: spawned.col, y_fp: toFp(destRow) },
              speed_fp: spawned.speed_fp,
            });
          }
        }

        board.removeUnit(unit);
      }
    }

    // ── Remove destroyed buildings ─────────────────────────────────────────
    for (const building of Array.from(board.buildings.values())) {
      if (building.isDead) {
        state.pushEvent({
          type:       'building_destroyed',
          buildingId: building.id,
          col:        building.col,
          row:        building.row,
        });
        board.removeBuilding(building);
      }
    }
  }

  // ─── Target finding ───────────────────────────────────────────────────────

  private findTarget(unit: Unit, state: GameState): Unit | Building | EscortUnit | null {
    const board = state.board;

    // Top-side (enemy) units can also target moving escort units (§4.9.3).
    // Collect active escorts once; empty for Bottom-side units and non-escort levels.
    const movingEscorts = unit.side === Side.Top
      ? state.escorts.filter(e => e.status === 'moving')
      : [];

    // Units advance single-file along their lane, but engage ANY enemy within
    // attack range around them (Chebyshev distance), not just the cell straight
    // ahead. Scan ring by ring so the closest target is preferred; within a ring:
    //   taunt unit > enemy unit > escort unit > enemy building.
    // Stealth: enemies with stealth are invisible at Chebyshev dist > 2.
    // Flying: units without canTargetFlying cannot target flying enemies.
    let bestTarget: Unit | Building | EscortUnit | null = null;
    let bestTaunt  = false;  // whether bestTarget has taunt
    let bestDist   = Infinity;

    for (let dist = 1; dist <= unit.effectiveRange; dist++) {
      let buildingHit: Building | null = null;
      let escortHit: EscortUnit | null = null;

      // Check escort units at this Chebyshev distance.
      if (movingEscorts.length > 0) {
        for (const escort of movingEscorts) {
          const eRow = Math.round(fromFp(escort.row_fp));
          const eCol = Math.round(fromFp(escort.col_fp));
          const d    = Math.max(Math.abs(unit.row - eRow), Math.abs(unit.col - eCol));
          if (d === dist && !escortHit) {
            escortHit = escort;
          }
        }
      }

      for (let dr = -dist; dr <= dist; dr++) {
        for (let dc = -dist; dc <= dist; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
          const checkRow = unit.row + dr;
          const checkCol = unit.col + dc;
          if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
          if (checkCol < 0 || checkCol >= BOARD_COLS) continue;

          const enemy = board.getUnitAt(checkCol, checkRow);
          if (enemy && enemy.side !== unit.side && !enemy.isDead) {
            // Flying filter: skip flying targets if attacker can't target them.
            if (enemy.flying && !unit.canTargetFlying) continue;
            // Stealth: invisible beyond dist 2.
            if (enemy.stealth && dist > 2) continue;

            // Taunt preference: keep best candidate, prefer taunt.
            const hasTaunt = enemy.taunt;
            if (
              bestTarget === null ||
              (!bestTaunt && hasTaunt) ||
              (bestTaunt === hasTaunt && dist < bestDist)
            ) {
              bestTarget = enemy;
              bestTaunt  = hasTaunt;
              bestDist   = dist;
            }
          }

          if (!buildingHit) {
            const building = board.getBuildingAt(checkCol, checkRow);
            if (building && building.side !== unit.side && !building.isDead) buildingHit = building;
          }
        }
      }

      // Accumulate escort candidate (lower priority than taunt unit).
      if (escortHit && bestTarget === null) {
        bestTarget = escortHit;
        bestDist   = dist;
      }
      // Accumulate building candidate (lowest priority).
      if (buildingHit && bestTarget === null) {
        bestTarget = buildingHit;
        bestDist   = dist;
      }
    }

    return bestTarget;
  }

  private findTargetForBuilding(building: Building, state: GameState): Unit | null {
    const board     = state.board;
    const enemySide = building.side === Side.Bottom ? Side.Top : Side.Bottom;
    const range     = building.attackRange;

    // Scan all cells within attackRange in every direction (Chebyshev distance),
    // ring by ring so closer targets are preferred.
    for (let dist = 1; dist <= range; dist++) {
      for (let dr = -dist; dr <= dist; dr++) {
        for (let dc = -dist; dc <= dist; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
          const checkRow = building.row + dr;
          const checkCol = building.col + dc;
          if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
          if (checkCol < 0 || checkCol >= BOARD_COLS) continue;
          const unit = board.getUnitAt(checkCol, checkRow);
          if (unit && unit.side === enemySide && !unit.isDead) {
            // Flying filter: buildings without canTargetFlying skip flying targets.
            if (unit.flying && !building.canTargetFlying) continue;
            return unit;
          }
        }
      }
    }
    return null;
  }

  // ─── Attack execution ─────────────────────────────────────────────────────

  private performUnitAttack(
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
      markEnemies:   attacker.markEnemies,
    };

    if (attacker.projectile) {
      this.fireProjectile(state, attacker.x_fp, attacker.y_fp, attacker.projectile, target, payload);
    } else {
      this.resolveAttackHit(state, payload, target);
    }
  }

  private performBuildingAttack(
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
      markEnemies:   false,
    };

    if (building.projectile) {
      this.fireProjectile(state, toFp(building.col), toFp(building.row), building.projectile, target, payload);
    } else {
      this.resolveAttackHit(state, payload, target);
    }
  }

  // ─── Hit resolution (shared by melee hits and projectile impacts) ──────────

  /**
   * Apply a (frozen) attack payload to a live target: primary damage + events,
   * then lifesteal / slow / splash / piercing. Called immediately for melee, and
   * at impact for projectiles. Event order matches the original inline melee path
   * exactly, so existing melee replays stay bit-identical.
   */
  private resolveAttackHit(
    state: GameState,
    payload: ProjectilePayload,
    target: Unit | Building | EscortUnit,
  ): void {
    let rawDamage = payload.rawDamage;

    // burstOnSingle (Max): 2× damage when only one live enemy remains on target side.
    if (payload.burstOnSingle && target instanceof Unit) {
      let liveCount = 0;
      for (const u of state.board.units.values()) {
        if (!u.isDead && u.side === target.side) { liveCount++; if (liveCount > 1) break; }
      }
      if (liveCount === 1) rawDamage = rawDamage * 2;
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

  // ─── Projectiles (ranged attacks) ──────────────────────────────────────────

  private targetRef(target: Unit | Building | EscortUnit): { targetId: number; targetKind: ProjectileTargetKind } {
    if (target instanceof Unit)     return { targetId: target.id,        targetKind: 'unit' };
    if (target instanceof Building) return { targetId: target.id,        targetKind: 'building' };
    return                                 { targetId: target.numericId, targetKind: 'escort' };
  }

  /** Spawn a homing projectile carrying `payload`, and emit projectile_fired. */
  private fireProjectile(
    state: GameState,
    startCol_fp: Fp,
    startRow_fp: Fp,
    spec: { speed: number; kind: string },
    target: Unit | Building | EscortUnit,
    payload: ProjectilePayload,
  ): void {
    const { targetId, targetKind } = this.targetRef(target);
    const proj = new Projectile(startCol_fp, startRow_fp, spec.speed, targetId, targetKind, payload, spec.kind);
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
  private resolveProjectileTarget(proj: Projectile, state: GameState): Unit | Building | EscortUnit | null {
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
  private tickProjectiles(state: GameState): void {
    if (state.projectiles.length === 0) return;

    const survivors: Projectile[] = [];
    for (const proj of state.projectiles) {
      const target = this.resolveProjectileTarget(proj, state);
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
        this.resolveAttackHit(state, proj.payload, target);
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
}
