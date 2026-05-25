import { HASTE_DURATION, HASTE_SPEED_MULT, METEOR_DAMAGE } from '../config';
import { GameState } from '../GameState';
import { ActiveSpell, Side, SpellType } from '../types';

export class SpellSystem {
  castHaste(side: Side, state: GameState): void {
    // Remove existing haste for this side (no stacking)
    state.activeSpells = state.activeSpells.filter(
      (s) => !(s.spellType === SpellType.Haste && s.side === side),
    );

    // Apply speed boost to all friendly units
    for (const unit of state.board.units.values()) {
      if (unit.side === side) {
        unit.speed = unit.baseSpeed * HASTE_SPEED_MULT;
      }
    }

    state.activeSpells.push({
      spellType: SpellType.Haste,
      side,
      remainingTime: HASTE_DURATION,
    });

    state.pushEvent({ type: 'spell_cast', spellType: SpellType.Haste, side });
  }

  castMeteor(side: Side, centerCol: number, centerRow: number, state: GameState): void {
    const board = state.board;

    // Damage all units and buildings in 2×2 area
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        const col = centerCol + dc;
        const row = centerRow + dr;

        const unit = board.getUnitAt(col, row);
        if (unit && !unit.isDead) unit.takeDamage(METEOR_DAMAGE);

        const building = board.getBuildingAt(col, row);
        if (building && !building.isDead) building.takeDamage(METEOR_DAMAGE);
      }
    }

    state.pushEvent({
      type: 'spell_cast',
      spellType: SpellType.Meteor,
      side,
      col: centerCol,
      row: centerRow,
    });
  }

  tick(state: GameState, dt: number): void {
    const expired: ActiveSpell[] = [];

    for (const spell of state.activeSpells) {
      spell.remainingTime -= dt;
      if (spell.remainingTime <= 0) {
        expired.push(spell);
      }
    }

    for (const spell of expired) {
      this.expireSpell(spell, state);
      state.activeSpells.splice(state.activeSpells.indexOf(spell), 1);
    }
  }

  private expireSpell(spell: ActiveSpell, state: GameState): void {
    if (spell.spellType === SpellType.Haste) {
      // Reset speed for all units of this side
      for (const unit of state.board.units.values()) {
        if (unit.side === spell.side) {
          unit.resetSpeed();
        }
      }
    }
  }
}
