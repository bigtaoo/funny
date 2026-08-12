import { BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '../config';
import { FP_SCALE, TICK_RATE, toFp, fp, addFp, minFp } from '../math/fixed';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Side } from '../types';

/**
 * TraitSystem — per-tick passive trait effects (§4.4c).
 *
 * Runs BEFORE CombatSystem each tick so regen/heals are applied before
 * damage is resolved.
 *
 * Handles:
 *   - regenPerSec:    self HP regen (added directly into hp_fp each tick, ADR-065)
 *   - aura_heal:      heal nearby friendlies each tick
 *   - slow expiry:    decrement slowRemainingTicks, resetSpeed on expiry
 *   - summonOnTimer:  countdown; spawn unit at summoner's position when ready
 */
export class TraitSystem {
  tick(state: GameState): void {
    // ── Aura heal: each healer adds its heal-per-tick directly into nearby friendlies'
    // hp_fp (clamped to maxHp_fp). ADR-065: hp_fp already carries milli-HP precision (same
    // fp domain as healFpPerTick), so no separate accumulator is needed — pre-ADR-065 this
    // drained a dedicated healAccFp one whole HP point at a time.
    for (const unit of state.board.units.values()) {
      if (unit.isDead || unit.traits.length === 0) continue;
      for (const trait of unit.traits) {
        if (trait.type === 'aura_heal') {
          const healFpPerTick = fp(Math.round(trait.hps * FP_SCALE / TICK_RATE));
          if (healFpPerTick <= 0) continue;
          for (const ally of state.board.units.values()) {
            if (ally.isDead || ally.side !== unit.side || ally === unit) continue;
            const dist = Math.max(Math.abs(ally.row - unit.row), Math.abs(ally.col - unit.col));
            if (dist <= trait.radius) {
              ally.hp_fp = minFp(ally.maxHp_fp, addFp(ally.hp_fp, healFpPerTick));
            }
          }
        }
      }
    }

    // ── Per-unit tick effects ─────────────────────────────────────────────
    for (const unit of state.board.units.values()) {
      if (unit.isDead) continue;

      // Regen: add directly into hp_fp each tick (ADR-065 — see class doc comment).
      if (unit.regenFpPerTick > 0) {
        unit.hp_fp = minFp(unit.maxHp_fp, addFp(unit.hp_fp, unit.regenFpPerTick));
      }

      // Slow expiry: reset speed when countdown reaches 0.
      if (unit.slowRemainingTicks > 0) {
        unit.slowRemainingTicks--;
        if (unit.slowRemainingTicks === 0) {
          unit.resetSpeed();
        }
      }

      // Mark expiry (Mara's markEnemies debuff).
      if (unit.markedTicks > 0) unit.markedTicks--;

      // summonOnTimer: spawn a unit at the summoner's position.
      if (unit.summonOnTimer && unit.summonCooldownTicks > 0) {
        unit.summonCooldownTicks--;
        if (unit.summonCooldownTicks === 0) {
          unit.summonCooldownTicks = unit.summonOnTimer.intervalTicks;
          this.spawnSummon(unit, state);
        }
      }
    }
  }

  private spawnSummon(summoner: Unit, state: GameState): void {
    const { type: summonType } = summoner.summonOnTimer!;
    const bp      = state.unitBlueprints[summonType];
    const spawned = new Unit(summonType, summoner.side, summoner.col, summoner.row, bp, undefined, state.allocUnitId());
    state.board.addUnit(spawned);
    state.stats[state.ownerOf(summoner.side)].unitsSent++;
    const destRow = summoner.side === Side.Bottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
    state.pushEvent({
      type:      'unit_spawned',
      unitId:    spawned.id,
      owner:     state.ownerOf(summoner.side),
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
