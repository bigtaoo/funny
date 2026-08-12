/**
 * Tests for U10: SLG defense config knobs wired to the engine.
 *   - garrison:          pre-placed defender (Top) units at specific positions
 *   - defenderBuildings: pre-placed buildings on the defender's building row
 *   - defenderBaseLevel: defender's base upgrade level pre-applied at start
 */

import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@nw/engine/GameEngine';
import { TOP_BUILDING_ROW, BOTTOM_BUILDING_ROW } from '@nw/engine/config';
import { BuildingType, UnitType, Side, GamePhase } from '@nw/engine/types';
import type { GameConfig } from '@nw/engine/types';
import type { LevelDefinition } from '@nw/engine/campaign/LevelDefinition';
import { parseLevelDefinition } from '@nw/engine/campaign/levelSchema';

const TICK_DT = 1 / 30;

function makeSiegeConfig(level: LevelDefinition): GameConfig {
  return { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level };
}

function baseLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'siege_test',
    chapter: 0,
    seed: 42,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    ...overrides,
  };
}

function runTicks(cfg: GameConfig, ticks: number) {
  const engine = createGameEngine(cfg);
  for (let i = 0; i < ticks; i++) engine.tick(TICK_DT);
  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// garrison — pre-placed defender units
// ─────────────────────────────────────────────────────────────────────────────

describe('garrison — pre-placed defender units', () => {
  it('garrison units appear on the board at tick 0', () => {
    const level = baseLevel({
      garrison: [
        { unitType: UnitType.Infantry, col: 0, row: 10 },
        { unitType: UnitType.Runner,   col: 2, row: 12 },
      ],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topUnits = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && !u.isDead);
    expect(topUnits).toHaveLength(2);
  });

  it('garrison units are placed at the correct col and row', () => {
    const level = baseLevel({
      garrison: [{ unitType: UnitType.Ironclad, col: 3, row: 8 }],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topUnits = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && !u.isDead);
    expect(topUnits).toHaveLength(1);
    expect(topUnits[0]!.col).toBe(3);
    // Row may have advanced 1 tick toward Bottom, so allow ±1.
    expect(Math.abs(topUnits[0]!.row - 8)).toBeLessThanOrEqual(1);
  });

  it('garrison units emit unit_spawned events on first tick', () => {
    const level = baseLevel({
      garrison: [
        { unitType: UnitType.Infantry, col: 0, row: 10 },
        { unitType: UnitType.Infantry, col: 1, row: 10 },
      ],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const spawned = engine.state.events.filter(e => e.type === 'unit_spawned' && (e as { owner: number }).owner === 1);
    expect(spawned).toHaveLength(2);
  });

  it('garrison units emit unit_move_start events on first tick', () => {
    const level = baseLevel({
      garrison: [{ unitType: UnitType.Runner, col: 0, row: 10 }],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const moveStarts = engine.state.events.filter(e => e.type === 'unit_move_start');
    // At least one for the garrison unit (there may be others if the unit moves this tick too).
    expect(moveStarts.length).toBeGreaterThan(0);
  });

  it('garrison units move toward the bottom base (decreasing row)', () => {
    const level = baseLevel({
      garrison: [{ unitType: UnitType.Runner, col: 0, row: 10 }],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    // Run 60 ticks — enough for a Runner to advance several rows.
    for (let i = 0; i < 60; i++) engine.tick(TICK_DT);

    const topUnits = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && !u.isDead);
    if (topUnits.length > 0) {
      // Runner started at row 10 and moves toward row 0 — row should have decreased.
      expect(topUnits[0]!.row).toBeLessThan(10);
    }
  });

  it('no garrison units on the board when garrison is not specified', () => {
    const level = baseLevel();
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topUnits = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && !u.isDead);
    expect(topUnits).toHaveLength(0);
  });

  it('multiple garrison units in the same lane coexist', () => {
    const level = baseLevel({
      garrison: [
        { unitType: UnitType.Infantry, col: 0, row: 14 },
        { unitType: UnitType.Infantry, col: 0, row: 10 },
      ],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topInCol0 = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && u.col === 0 && !u.isDead);
    expect(topInCol0).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defenderBuildings — pre-placed buildings on defender's building row
// ─────────────────────────────────────────────────────────────────────────────

describe('defenderBuildings — pre-placed defender buildings', () => {
  it('defender building appears on the board at tick 0', () => {
    const level = baseLevel({
      defenderBuildings: [{ buildingType: BuildingType.ArrowTower, col: 0 }],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top && !b.isDead);
    expect(topBuildings).toHaveLength(1);
  });

  it('defender buildings are placed at TOP_BUILDING_ROW', () => {
    const level = baseLevel({
      defenderBuildings: [{ buildingType: BuildingType.Barracks, col: 2 }],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top && !b.isDead);
    expect(topBuildings).toHaveLength(1);
    expect(topBuildings[0]!.row).toBe(TOP_BUILDING_ROW);
    expect(topBuildings[0]!.col).toBe(2);
  });

  it('defender buildings emit building_placed events on first tick', () => {
    const level = baseLevel({
      defenderBuildings: [
        { buildingType: BuildingType.ArrowTower, col: 0 },
        { buildingType: BuildingType.Barracks,   col: 1 },
      ],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const placed = engine.state.events.filter(e => e.type === 'building_placed' && (e as { owner: number }).owner === 1);
    expect(placed).toHaveLength(2);
  });

  it('multiple defender buildings appear in their respective columns', () => {
    const level = baseLevel({
      defenderBuildings: [
        { buildingType: BuildingType.ArrowTower, col: 0 },
        { buildingType: BuildingType.ArrowTower, col: 3 },
        { buildingType: BuildingType.Barracks,   col: 7 },
      ],
    });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top);
    expect(topBuildings).toHaveLength(3);
    const cols = topBuildings.map(b => b.col).sort();
    expect(cols).toEqual([0, 3, 7]);
  });

  it('arrow tower defender building attacks attacker units that enter its range', () => {
    // Place an ArrowTower; spawn an attacker unit on the same col by playing a card from the
    // attacker's (Bottom) hand. After enough ticks the tower should have damaged it.
    const level = baseLevel({
      defenderBuildings: [{ buildingType: BuildingType.ArrowTower, col: 0 }],
      waves: { entries: [] },
      startInk: 20, // enough to afford any starting-hand unit card immediately (default is 0)
    });
    const cfg: GameConfig = { ...makeSiegeConfig(level), level };
    const engine = createGameEngine(cfg);
    engine.tick(TICK_DT); // settle initial hand draw

    const slots = engine.state.bottomPlayer.hand.slots;
    const slot = slots.findIndex(s => s?.card?.unitType !== undefined);
    expect(slot).toBeGreaterThanOrEqual(0); // sanity: the hand actually has a playable unit card
    engine.playCard(slot, 0);
    engine.tick(TICK_DT); // play_card is only processed on the next tick's command pass

    const attacker = Array.from(engine.state.board.units.values()).find(u => u.side === Side.Bottom);
    expect(attacker).toBeDefined();
    const startHp = attacker!.hp_fp;
    const attackerId = attacker!.id;

    for (let i = 0; i < 300; i++) engine.tick(TICK_DT);

    // The tower must actually have dealt damage: the attacker either died or lost HP relative
    // to its spawn value (a bare "engine didn't crash" check has no assertion power here).
    const after = engine.state.board.units.get(attackerId);
    const damaged = !after || after.isDead || after.hp_fp < startHp;
    expect(damaged).toBe(true);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top && !b.isDead);
    expect(topBuildings.length).toBeGreaterThan(0);
  });

  it('no defender buildings when defenderBuildings not specified', () => {
    const engine = createGameEngine(makeSiegeConfig(baseLevel()));
    engine.tick(TICK_DT);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top);
    expect(topBuildings).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defenderBaseLevel — pre-applied base upgrade level
// ─────────────────────────────────────────────────────────────────────────────

describe('defenderBaseLevel — pre-applied base upgrade level', () => {
  it('topPlayer.upgradeLevel equals defenderBaseLevel at game start', () => {
    for (const lvl of [0, 1, 2, 3]) {
      const level = baseLevel({ defenderBaseLevel: lvl });
      const engine = createGameEngine(makeSiegeConfig(level));
      engine.tick(TICK_DT);
      expect(engine.state.topPlayer.upgradeLevel).toBe(lvl);
    }
  });

  it('defenderBaseLevel does not affect the attacker (Bottom) player upgrade level', () => {
    const level = baseLevel({ defenderBaseLevel: 3 });
    const engine = createGameEngine(makeSiegeConfig(level));
    engine.tick(TICK_DT);
    expect(engine.state.bottomPlayer.upgradeLevel).toBe(0);
  });

  it('default upgrade level is 0 when defenderBaseLevel is not specified', () => {
    const engine = createGameEngine(makeSiegeConfig(baseLevel()));
    engine.tick(TICK_DT);
    expect(engine.state.topPlayer.upgradeLevel).toBe(0);
  });

  it('defenderBaseLevel=0 is a no-op (same as default)', () => {
    const engineDefault = createGameEngine(makeSiegeConfig(baseLevel()));
    const engineExplicit = createGameEngine(makeSiegeConfig(baseLevel({ defenderBaseLevel: 0 })));
    engineDefault.tick(TICK_DT);
    engineExplicit.tick(TICK_DT);
    expect(engineDefault.state.topPlayer.upgradeLevel).toBe(engineExplicit.state.topPlayer.upgradeLevel);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// levelSchema validation for new fields
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_VALID_WAVES = { entries: [{ atTick: 0, unitType: 'infantry', col: 0, count: 1 }] };

describe('levelSchema: garrison validation', () => {
  const validBase = {
    id: 'v', chapter: 1, seed: 1,
    objective: { kind: 'destroy_base' },
    waves: SCHEMA_VALID_WAVES,
  };

  it('accepts valid garrison entries', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      garrison: [
        { unitType: 'infantry', col: 0, row: 10 },
        { unitType: 'runner',   col: 2, row: 1  },
      ],
    })).not.toThrow();
  });

  it('rejects garrison row = 0 (BOTTOM_BUILDING_ROW)', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      garrison: [{ unitType: 'infantry', col: 0, row: BOTTOM_BUILDING_ROW }],
    })).toThrow('garrison row must be');
  });

  it('rejects garrison row = TOP_BUILDING_ROW (17)', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      garrison: [{ unitType: 'infantry', col: 0, row: TOP_BUILDING_ROW }],
    })).toThrow('garrison row must be');
  });

  it('rejects garrison with a base-column col (5)', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      garrison: [{ unitType: 'infantry', col: 5, row: 10 }],
    })).toThrow('not an attack lane');
  });

  it('rejects garrison with an unknown unitType', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      garrison: [{ unitType: 'unknown_unit', col: 0, row: 10 }],
    })).toThrow('unknown unit type');
  });
});

describe('levelSchema: defenderBuildings validation', () => {
  const validBase = {
    id: 'v', chapter: 1, seed: 1,
    objective: { kind: 'destroy_base' },
    waves: SCHEMA_VALID_WAVES,
  };

  it('accepts valid defenderBuildings entries', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      defenderBuildings: [
        { buildingType: 'barracks',    col: 0 },
        { buildingType: 'arrow_tower', col: 3 },
      ],
    })).not.toThrow();
  });

  it('rejects defenderBuildings with a base-column col (6)', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      defenderBuildings: [{ buildingType: 'barracks', col: 6 }],
    })).toThrow('not an attack lane');
  });

  it('rejects defenderBuildings with an unknown buildingType', () => {
    expect(() => parseLevelDefinition({
      ...validBase,
      defenderBuildings: [{ buildingType: 'super_cannon', col: 0 }],
    })).toThrow('unknown building type');
  });
});

describe('levelSchema: defenderBaseLevel validation', () => {
  const validBase = {
    id: 'v', chapter: 1, seed: 1,
    objective: { kind: 'destroy_base' },
    waves: SCHEMA_VALID_WAVES,
  };

  it('accepts valid defenderBaseLevel values 0–2', () => {
    for (const lvl of [0, 1, 2]) {
      expect(() => parseLevelDefinition({ ...validBase, defenderBaseLevel: lvl })).not.toThrow();
    }
  });

  it('rejects defenderBaseLevel > 2', () => {
    expect(() => parseLevelDefinition({ ...validBase, defenderBaseLevel: 3 })).toThrow('must be 0..');
  });

  it('rejects negative defenderBaseLevel', () => {
    expect(() => parseLevelDefinition({ ...validBase, defenderBaseLevel: -1 })).toThrow('must be 0..');
  });

  it('rejects non-integer defenderBaseLevel', () => {
    expect(() => parseLevelDefinition({ ...validBase, defenderBaseLevel: 1.5 })).toThrow('expected an integer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined: siege with garrison + defenderBuildings + defenderBaseLevel
// ─────────────────────────────────────────────────────────────────────────────

describe('combined SLG defense config', () => {
  it('all three knobs work together without crashing', () => {
    const level = baseLevel({
      garrison: [
        { unitType: UnitType.Infantry, col: 0, row: 12 },
        { unitType: UnitType.Ironclad, col: 2, row: 14 },
      ],
      defenderBuildings: [
        { buildingType: BuildingType.ArrowTower, col: 3 },
        { buildingType: BuildingType.Barracks,   col: 7 },
      ],
      defenderBaseLevel: 2,
    });
    const engine = runTicks(makeSiegeConfig(level), 60);

    expect(engine.state.phase).toBe(GamePhase.Playing);
    expect(engine.state.topPlayer.upgradeLevel).toBe(2);

    const topUnits = Array.from(engine.state.board.units.values())
      .filter(u => u.side === Side.Top && !u.isDead);
    expect(topUnits.length).toBeGreaterThan(0);

    const topBuildings = Array.from(engine.state.board.buildings.values())
      .filter(b => b.side === Side.Top && !b.isDead);
    expect(topBuildings).toHaveLength(2);
  });

  it('siege mode without any defense config knobs works (backward compat)', () => {
    const level = baseLevel({
      waves: { entries: [{ atTick: 10, unitType: UnitType.Infantry, col: 0, count: 2 }] },
    });
    expect(() => runTicks(makeSiegeConfig(level), 30)).not.toThrow();
  });
});
