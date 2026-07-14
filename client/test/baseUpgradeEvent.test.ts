/**
 * base_upgraded event: a successful base upgrade must emit exactly one
 * base_upgraded{owner, level} into the engine event stream, so the renderer can
 * play the one-shot level-up flash. The persistent tier texture is reconciled
 * separately (BoardView.setBaseUpgradeLevel polls player.upgradeLevel) — this
 * event is purely the transient effect trigger, mirroring how base_hp_changed
 * drives the crack flash. See client/test/ui/baseUpgradeMapping.ui.ts for the
 * owner→sprite routing of the effect itself.
 */

import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import type { GameConfig, GameEvent } from '../src/game/types';

const TICK_DT = 1 / 30;

function makeConfig(): GameConfig {
  return { seed: 42, players: [{ id: 0 }, { id: 1 }], mode: 'pvp' };
}

/** Drive a few ticks, accumulating every event emitted across them. */
function drainEvents(engine: ReturnType<typeof createGameEngine>, ticks: number): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    engine.tick(TICK_DT);
    all.push(...engine.state.events);
  }
  return all;
}

describe('base_upgraded event', () => {
  it('a successful upgrade emits base_upgraded{owner:0, level:1}', () => {
    const engine = createGameEngine(makeConfig());
    engine.state.bottomPlayer.addInkFp(999 * 1000); // 999 ink (fp scale 1000) — well over the level-1 cost (30)

    engine.upgradeBase(); // local command → owner 0
    const events = drainEvents(engine, 3);

    const upgrades = events.filter((e) => e.type === 'base_upgraded');
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]).toMatchObject({ type: 'base_upgraded', owner: 0, level: 1 });
    expect(engine.state.bottomPlayer.upgradeLevel).toBe(1);
  });

  it('an upgrade the player cannot afford emits no base_upgraded event', () => {
    const engine = createGameEngine(makeConfig());
    // No level → start ink is 0; a few ticks accrue far less than the level-1 cost (30).

    engine.upgradeBase();
    const events = drainEvents(engine, 3);

    expect(events.filter((e) => e.type === 'base_upgraded')).toHaveLength(0);
    expect(engine.state.bottomPlayer.upgradeLevel).toBe(0);
  });
});
