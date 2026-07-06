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
 * Behavioural guard for the enhanced AI (IMPROVEMENT_PLAN item 2, extended to the
 * 1-10 difficulty curve).
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
const SWORD = cardOf((c) => c.unitType === UnitType.Infantry);
const ARCHER = cardOf((c) => c.unitType === UnitType.Archer);

function freshState(): GameState {
  return new GameState(12345);
}

function giveInk(state: GameState, ink: number): void {
  state.topPlayer.addInkFp(ink * FP_SCALE);
}

/** Place an enemy (Bottom) unit at a grid cell. */
function addEnemy(state: GameState, col: number, row: number, unitType: UnitType = UnitType.Infantry): void {
  state.board.addUnit(new Unit(unitType, Side.Bottom, col, row));
}

/** Run the AI until it emits a command (or give up after a few intervals). */
function firstDecision(ai: AISystem, state: GameState): PlayerCommand[] {
  for (let tick = 0; tick < 300; tick++) {
    const cmds = ai.decideTick(tick, state);
    if (cmds.length > 0) return cmds;
  }
  return [];
}

describe('AISystem — 10-level difficulty curve', () => {
  it('L5 (mid) meteors a cluster pressing its base', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
    // Two enemies adjacent near the AI base (row 17).
    addEnemy(state, 3, 15);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 5);
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

  it('L5 falls back to an arrow tower in the pressured lane when no meteor', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, TOWER, 900);
    addEnemy(state, 4, 14);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 5);
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(0);
    expect(cmd.col).toBe(4); // the most-threatened open building lane
  });

  it('L5 pushes a unit when there is no threat (offense)', () => {
    const state = freshState();
    // Low on ink (below the upgrade-banking threshold) so the AI spends now.
    giveInk(state, 8);
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);

    const ai = new AISystem(new Prng(1), 5);
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(0);
    expect(cmd.col).toBeDefined();
    expect(cmd.row).toBeUndefined(); // units carry no row
  });

  it('L5 upgrades the base when it is safe and affordable', () => {
    const state = freshState();
    giveInk(state, 60); // ≥ first upgrade cost (50), now reachable (INK_CAP 300)
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);
    // No enemies on the board → no threat → economy phase prioritises the upgrade.

    const ai = new AISystem(new Prng(1), 5);
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe('upgrade_base');
  });

  it('L1 does not use meteor/towers (passive punching bag)', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
    addEnemy(state, 3, 15);
    addEnemy(state, 4, 15);

    const ai = new AISystem(new Prng(1), 1);
    const cmds = firstDecision(ai, state);

    // No unit/tower in hand and meteor disabled → L1 sits on its hands.
    expect(cmds).toHaveLength(0);
  });

  it('L10 reacts strictly faster than L1 (thinkIntervalTicks decreases monotonically)', () => {
    const state = freshState();
    giveInk(state, 8);
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);

    let l1Ticks = -1;
    const l1 = new AISystem(new Prng(1), 1);
    for (let tick = 0; tick < 300; tick++) {
      if (l1.decideTick(tick, state).length > 0) { l1Ticks = tick; break; }
    }

    const state10 = freshState();
    giveInk(state10, 8);
    state10.topPlayer.hand.drawIntoSlot(0, SWORD, 900);
    let l10Ticks = -1;
    const l10 = new AISystem(new Prng(1), 10);
    for (let tick = 0; tick < 300; tick++) {
      if (l10.decideTick(tick, state10).length > 0) { l10Ticks = tick; break; }
    }

    expect(l1Ticks).toBeGreaterThan(0);
    expect(l10Ticks).toBeGreaterThan(0);
    expect(l10Ticks).toBeLessThan(l1Ticks);
  });

  it('L10 never decides faster than the 12-tick professional-cadence floor', () => {
    const state = freshState();
    giveInk(state, 8);
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);
    const ai = new AISystem(new Prng(1), 10);

    let firstTick = -1;
    for (let tick = 0; tick < 20; tick++) {
      if (ai.decideTick(tick, state).length > 0) { firstTick = tick; break; }
    }
    expect(firstTick).toBeGreaterThanOrEqual(11); // 12th call (tick index 11) at the earliest
  });

  it('L8 counter-picks Archer (range 2) over Infantry against a lone enemy Archer', () => {
    const state = freshState();
    giveInk(state, 20);
    state.topPlayer.hand.drawIntoSlot(0, SWORD, 900);
    state.topPlayer.hand.drawIntoSlot(1, ARCHER, 900);
    // Enemy archer sitting in lane 0 — outranges Infantry, favors sending our own Archer back.
    addEnemy(state, 0, 8, UnitType.Archer);

    const ai = new AISystem(new Prng(1), 8);
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd.type).toBe('play_card');
    if (cmd.type !== 'play_card') return;
    expect(cmd.handIndex).toBe(1); // the Archer slot, not the legacy-preferred Infantry
  });

  it('L8 skips an offensive meteor on a cheap Runner cluster (value-gated)', () => {
    const state = freshState();
    giveInk(state, 30);
    state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
    state.topPlayer.hand.drawIntoSlot(1, SWORD, 900);
    // Two cheap Runners (3 ink each = 6 total) clustered far from the base: the
    // cluster-size threshold (2) is met, but 6 ink isn't worth a 12-ink Meteor.
    addEnemy(state, 3, 4, UnitType.Runner);
    addEnemy(state, 4, 4, UnitType.Runner);

    const ai = new AISystem(new Prng(1), 8);
    const cmds = firstDecision(ai, state);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    if (cmd.type !== 'play_card') throw new Error('expected play_card');
    expect(cmd.handIndex).not.toBe(0); // did not spend the meteor
  });

  describe('fair-play invariant: decisions never depend on the opponent hand', () => {
    it('decideTick output is identical regardless of bottomPlayer.hand contents', () => {
      const build = (): GameState => {
        const state = freshState();
        giveInk(state, 30);
        state.topPlayer.hand.drawIntoSlot(0, METEOR, 900);
        state.topPlayer.hand.drawIntoSlot(1, SWORD, 900);
        addEnemy(state, 3, 15);
        addEnemy(state, 4, 15);
        return state;
      };

      const stateA = build();
      // Opponent hand left empty.

      const stateB = build();
      // Opponent hand stuffed with cards the AI must never react to.
      stateB.bottomPlayer.hand.drawIntoSlot(0, METEOR, 900);
      stateB.bottomPlayer.hand.drawIntoSlot(1, TOWER, 900);
      stateB.bottomPlayer.hand.drawIntoSlot(2, ARCHER, 900);

      for (const level of [1, 5, 10] as const) {
        const cmdsA = firstDecision(new AISystem(new Prng(1), level), stateA);
        const cmdsB = firstDecision(new AISystem(new Prng(1), level), stateB);
        expect(cmdsB).toEqual(cmdsA);
      }
    });
  });
});
