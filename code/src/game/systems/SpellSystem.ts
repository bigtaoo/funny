import { HASTE_DURATION_TICKS, HASTE_SPEED_MULT, METEOR_DAMAGE } from '../config';
import { fp, scaleFp, toFp } from '../math/fixed';
import { GameState } from '../GameState';
import { ActiveSpell, Side, SpellType } from '../types';

/**
 * SpellSystem — cast and expire spells.
 * Uses integer tick counters for spell duration; no floating-point.
 */
export class SpellSystem {
  castHaste(side: Side, state: GameState): void {
    // Remove existing haste for this side (no stacking)
    state.activeSpells = state.activeSpells.filter(
      (s) => !(s.spellType === SpellType.Haste && s.side === side),
    );

    // Apply speed boost to all friendly units (integer multiplier via scaleFp)
    for (const unit of state.board.units.values()) {
      if (unit.side === side) {
        unit.speed_fp = scaleFp(HASTE_SPEED_MULT, unit.baseSpeed_fp);
      }
    }

    state.activeSpells.push({
      spellType:      SpellType.Haste,
      side,
      remainingTicks: HASTE_DURATION_TICKS,
    });

    state.pushEvent({
      type:      'spell_cast',
      spellType: SpellType.Haste,
      owner:     state.ownerOf(side),
      center:    { col: 3, y_fp: fp(0) }, // Haste has no single target
    });
  }

  castMeteor(side: Side, centerCol: number, centerRow: number, state: GameState): void {
    const board = state.board;

    // Damage all units and buildings in 2×2 area
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        const col  = centerCol + dc;
        const row  = centerRow + dr;
        const unit = board.getUnitAt(col, row);
        if (unit && !unit.isDead) unit.takeDamage(METEOR_DAMAGE);

        const building = board.getBuildingAt(col, row);
        if (building && !building.isDead) building.takeDamage(METEOR_DAMAGE);
      }
    }

    state.pushEvent({
      type:      'spell_cast',
      spellType: SpellType.Meteor,
      owner:     state.ownerOf(side),
      center:    { col: centerCol, y_fp: toFp(centerRow) },
    });
  }

  /** Decrement spell timers; expire finished spells. */
  tick(state: GameState): void {
    const expired: ActiveSpell[] = [];

    for (const spell of state.activeSpells) {
      spell.remainingTicks--;
      if (spell.remainingTicks <= 0) expired.push(spell);
    }

    for (const spell of expired) {
      this.expireSpell(spell, state);
      state.activeSpells.splice(state.activeSpells.indexOf(spell), 1);
    }
  }

  private expireSpell(spell: ActiveSpell, state: GameState): void {
    if (spell.spellType === SpellType.Haste) {
      for (const unit of state.board.units.values()) {
        if (unit.side === spell.side) unit.resetSpeed();
      }
    }
  }
}
