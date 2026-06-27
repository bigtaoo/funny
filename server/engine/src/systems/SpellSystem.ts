import { BRIDGE_COLLAPSE_DURATION_TICKS, HASTE_DURATION_TICKS, HASTE_SPEED_MULT, METEOR_DAMAGE, ROCKSLIDE_DAMAGE } from '../config';
import { fp, scaleFp, toFp } from '../math/fixed';
import { GameState } from '../GameState';
import { ActiveSpell, OwnerId, Side, SpellType } from '../types';

/** S9-3b: tally one cast of `spell` for `owner` (per-spell-type; feeds achievement cast.* stats). */
function bumpCast(state: GameState, owner: OwnerId, spell: SpellType): void {
  const cm = state.stats[owner].castsByType;
  cm[spell] = (cm[spell] ?? 0) + 1;
}

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

    bumpCast(state, state.ownerOf(side), SpellType.Haste);
    state.pushEvent({
      type:      'spell_cast',
      spellType: SpellType.Haste,
      owner:     state.ownerOf(side),
      center:    { col: 3, y_fp: fp(0) }, // Haste has no single target
    });
  }

  castMeteor(side: Side, centerCol: number, centerRow: number, state: GameState): void {
    const board  = state.board;
    const owner  = state.ownerOf(side);
    let hitsCount = 0;

    const maxCol = centerCol + 1;
    const maxRow = centerRow + 1;

    // Damage ENEMY units whose integer position falls in the 2×2 area.
    // Friendly units (same side as caster) are spared — Meteor only hits the opponent.
    // Iterate units directly rather than using getUnitAt(): the unitGrid is updated
    // in the movement phase, but castMeteor fires in processCommand (before movement).
    // The grid can lag by 1 tick, causing getUnitAt() to miss units that moved rows
    // this step but haven't had updateUnitCell() called yet.
    for (const unit of board.units.values()) {
      if (unit.isDead) continue;
      if (unit.side === side) continue; // never hit own units
      if (unit.col >= centerCol && unit.col <= maxCol &&
          unit.row >= centerRow && unit.row <= maxRow) {
        unit.takeDamage(METEOR_DAMAGE);
        hitsCount++;
      }
    }

    // Buildings: grid lookup is safe (at most one building per cell). Only hit enemy buildings.
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        const building = board.getBuildingAt(centerCol + dc, centerRow + dr);
        if (building && !building.isDead && building.side !== side) building.takeDamage(METEOR_DAMAGE);
      }
    }

    // Track spell hits for badge stats
    state.stats[owner].spellHits += hitsCount;
    bumpCast(state, owner, SpellType.Meteor); // S9-3b: feeds cast.meteor

    state.pushEvent({
      type:      'spell_cast',
      spellType: SpellType.Meteor,
      owner,
      center:    { col: centerCol, y_fp: toFp(centerRow) },
    });
  }

  /** Damages all units in `col` (PvE-only Rockslide spell, §4.9.2). */
  castRockslide(side: Side, col: number, state: GameState): void {
    const owner = state.ownerOf(side);
    let hits = 0;
    for (const unit of state.board.units.values()) {
      if (unit.isDead) continue;
      if (unit.col === col) { unit.takeDamage(ROCKSLIDE_DAMAGE); hits++; }
    }
    state.stats[owner].spellHits += hits;
    bumpCast(state, owner, SpellType.Rockslide);
    state.pushEvent({ type: 'spell_cast', spellType: SpellType.Rockslide, owner, center: { col, y_fp: fp(0) } });
  }

  /** Blocks an entire column for `BRIDGE_COLLAPSE_DURATION_TICKS` (PvE-only, §4.9.2). */
  castBridgeCollapse(side: Side, col: number, state: GameState, currentTick: number): void {
    state.tempBlockedCols.set(col, currentTick + BRIDGE_COLLAPSE_DURATION_TICKS);
    bumpCast(state, state.ownerOf(side), SpellType.BridgeCollapse);
    state.pushEvent({ type: 'spell_cast', spellType: SpellType.BridgeCollapse, owner: state.ownerOf(side), center: { col, y_fp: fp(0) } });
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
