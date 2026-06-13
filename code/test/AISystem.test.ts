import { describe, it, expect } from 'vitest';
import { AISystem } from '../src/game/systems/AISystem';
import { GameState } from '../src/game/GameState';
import { Prng } from '../src/game/math/prng';
import { Unit } from '../src/game/Unit';
import { CARD_DEFINITIONS } from '../src/game/config';
import { FP_SCALE } from '../src/game/math/fixed';
import {
  BuildingType,
  CardType,
  PlayerCommand,
  Side,
  SpellType,
  UnitType,
} from '../src/game/types';

/**
 * Behavioural guard for the enhanced AI (IMPROVEMENT_PLAN item 2).
 *
 * The AI plays the Top side. Bottom units advancing toward row 17 are the
 * threat. These tests build deliberate situations and assert the AI reacts the
 * intended way. All inputs are integer/state-derived, so the AI stays
 * deterministic (the golden-replay test guards run-vs-run identity separately).
 */

const cardOf = (pred: (c: typeof CARD_DEFINITIONS[number]) => boolean) =>
  CARD_DEFINITIONS.find(pred)!;

const METEOR = cardOf((c) => c.spellType === SpellType.Meteor);
const TOWER = cardOf((c) => c.buildingType === BuildingType.ArrowTower);
const SWORD = cardOf((c) => c.unitType === UnitType.Swordsman);

function freshState(): GameState {
  return new GameState(12345);
}

function giveInk(state: GameState, ink: number): void {
  state.topPlayer.addInkFp(ink * FP_SCALE);
}

/** Place an enemy (Bottom) unit at a grid cell. */
function addEnemy(state: GameState, col: number, row: number): void {
  state.board.addUnit(new Unit(UnitType.Swordsman, Side.Bottom, col, row));
}

/** Run the AI until it emits a command (or give up after a few intervals). */
function firstDecision(ai: AISystem, state: GameState): PlayerCommand[] {
  for (let tick = 0; tick < 300; tick++) {
    const cmds = ai.decideTick(tick, state);
    if (cmds.length > 0) return cmds;
  }
  return [];
}

describe('AISystem — enhanced decisions', () => {
  it('medium AI meteors a cluster pressing its base', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
    // Two enemies adjacent near the AI base (row 17).
    addEnemy(state, 3, 15);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 'medium');
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(0); // the meteor slot
    expect(cmd.col).toBeDefined();
    expect(cmd.row).toBeDefined();
    // Defensive nuke lands on the footprint nearest the base.
    expect(cmd.row!).toBeGreaterThanOrEqual(14);
  });

  it('falls back to an arrow tower in the pressured lane when no meteor', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, TOWER, 900);
    addEnemy(state, 4, 14);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 'medium');
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(0);
    expect(cmd.col).toBe(4); // the most-threatened open building lane
  });

  it('pushes a unit when there is no threat (offense)', () => {
    const state = freshState();
    // Low on ink (below the upgrade-banking threshold) so the AI spends now.
    giveInk(state, 8);
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);

    const ai = new AISystem(new Prng(1), 'medium');
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(0);
    expect(cmd.col).toBeDefined();
    expect(cmd.row).toBeUndefined(); // units carry no row
  });

  it('upgrades the base when it is safe and affordable', () => {
    const state = freshState();
    giveInk(state, 60); // ≥ first upgrade cost (50), now reachable (INK_CAP 300)
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);
    // No enemies on the board → no threat → economy phase prioritises the upgrade.

    const ai = new AISystem(new Prng(1), 'medium');
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe('upgrade_base');
  });

  it('easy AI does not use meteor/towers', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
    addEnemy(state, 3, 15);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 'easy');
    const cmds = firstDecision(ai, state);

    // No unit/tower in hand and meteor disabled → easy AI sits on its hands.
    expect(cmds).toHaveLength(0);
  });
});
