import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS } from '../src/game/config';
import { toFp } from '../src/game/math/fixed';
import { Side, UnitType, type GameConfig, type PlayerCommand } from '../src/game/types';

const infantryCard = CARD_DEFINITIONS.find((c) => c.id === 'infantry_1')!;

function netConfig(seed: number): GameConfig {
  // 'netplay' so no local AI runs — the engine only processes the commands we hand it.
  return { seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' };
}

describe('GameEngine — placement guard (processCommand)', () => {
  it('rejects a unit play into a spawn cell already occupied by a unit', () => {
    const engine = createGameEngine(netConfig(1));

    // First step fills both hands via emitInitialEvents; pass no commands.
    engine.step(0, []);

    // Inject two known infantry cards + ample ink so random draws don't interfere.
    const p = engine.state.bottomPlayer;
    p.hand.drawIntoSlot(0, infantryCard, 9999);
    p.hand.drawIntoSlot(1, infantryCard, 9999);
    p.addInkFp(toFp(100));

    const col = 0; // a valid ATTACK_LANE
    const cmd0: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: 0, col };
    const cmd1: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: 1, col };

    engine.step(1, [cmd0, cmd1]);

    // Only the first play spawns (spawnCount units); the second is rejected because
    // the spawn cell is now occupied — the engine is the single authority, so AI /
    // net-confirmed commands can't auto-stack a packed lane either.
    const bottomUnits = [...engine.state.board.units.values()].filter(
      (u) => u.side === Side.Bottom,
    );
    expect(bottomUnits.length).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount);

    // Exactly one card's worth of ink was spent (goldSpent is unaffected by regen).
    expect(engine.state.stats[0].goldSpent).toBe(infantryCard.cost);

    // The second slot's card was NOT consumed.
    expect(engine.state.bottomPlayer.hand.slots[1]?.card.id).toBe('infantry_1');
  });

  it('allows a second play into the same lane once the cell is free', () => {
    const engine = createGameEngine(netConfig(1));
    engine.step(0, []);

    const p = engine.state.bottomPlayer;
    p.hand.drawIntoSlot(0, infantryCard, 9999);
    p.addInkFp(toFp(100));

    const col = 0;
    engine.step(1, [{ type: 'play_card', owner: 0, tick: 1, handIndex: 0, col }]);
    const afterFirst = [...engine.state.board.units.values()].filter(
      (u) => u.side === Side.Bottom,
    ).length;
    expect(afterFirst).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount);

    // Advance enough ticks for the spawned units to clear the spawn cell.
    for (let t = 2; t < 80; t++) engine.step(t, []);

    p.hand.drawIntoSlot(0, infantryCard, 9999);
    p.addInkFp(toFp(100));
    engine.step(80, [{ type: 'play_card', owner: 0, tick: 80, handIndex: 0, col }]);

    const afterSecond = [...engine.state.board.units.values()].filter(
      (u) => u.side === Side.Bottom,
    ).length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});
