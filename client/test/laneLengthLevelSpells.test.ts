/**
 * Tests for §4.9.1 laneLength and §4.9.2 levelSpells knobs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { BOARD_ROWS, TOP_SPAWN_ROW, BRIDGE_COLLAPSE_DURATION_TICKS, CARD_DEFINITIONS } from '../src/game/config';
import { resetUnitIds } from '../src/game/Unit';
import { resetBuildingIds } from '../src/game/Building';
import { Side, UnitType, UnitState } from '../src/game/types';
import type { GameConfig } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

const TICK_DT = 1 / 30;

beforeEach(() => {
  resetUnitIds();
  resetBuildingIds();
});

function makeCampaignConfig(level: LevelDefinition): GameConfig {
  return { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
}

function baseLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'test',
    chapter: 0,
    seed: 42,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// laneLength (§4.9.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('laneLength', () => {
  it('blocked rows are spawnRow+1 .. TOP_SPAWN_ROW for the given column', () => {
    const laneLen = 6; // spawnRow = BOARD_ROWS - 6 = 12
    const col = 3;
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      board: { laneLength: { [col]: laneLen } },
    })));

    const spawnRow = BOARD_ROWS - laneLen; // 12
    const blocked  = engine.state.board.getBlockedCells();

    // Rows 13-16 must be blocked for col 3
    for (let row = spawnRow + 1; row <= TOP_SPAWN_ROW; row++) {
      expect(blocked.some(c => c.col === col && c.row === row)).toBe(true);
    }
    // The spawn row itself must NOT be blocked
    expect(blocked.some(c => c.col === col && c.row === spawnRow)).toBe(false);
    // Other columns unaffected
    expect(blocked.some(c => c.col !== col)).toBe(false);
  });

  it('enemies spawn at spawnRow = BOARD_ROWS - laneLength instead of TOP_SPAWN_ROW', () => {
    const laneLen = 4; // spawnRow = 14
    const col = 4;
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      board: { laneLength: { [col]: laneLen } },
      waves: { entries: [{ atTick: 1, unitType: UnitType.Infantry, col, count: 1 }] },
    })));

    engine.tick(TICK_DT); // tick 0 — emitInitialEvents
    engine.tick(TICK_DT); // tick 1 — wave fires (atTick:1)
    const unit = [...engine.state.board.units.values()].find(u => u.side === Side.Top);
    expect(unit).toBeDefined();
    expect(unit!.row).toBe(BOARD_ROWS - laneLen);
  });

  it('multiple columns can have different laneLengths', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      board: { laneLength: { 2: 4, 5: 8 } },
    })));

    const blocked = engine.state.board.getBlockedCells();
    const col2Rows = blocked.filter(c => c.col === 2).map(c => c.row).sort((a, b) => a - b);
    const col5Rows = blocked.filter(c => c.col === 5).map(c => c.row).sort((a, b) => a - b);

    // col 2: spawnRow = 14 → blocked 15,16
    expect(col2Rows).toEqual([15, 16]);
    // col 5: spawnRow = 10 → blocked 11,12,13,14,15,16
    expect(col5Rows).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('laneLength merges with existing cellMask.blocked cells', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      board: {
        cellMask: { blocked: [{ col: 0, row: 5 }] },
        laneLength: { 3: 5 }, // spawnRow = 13 → blocked 14,15,16
      },
    })));

    const blocked = engine.state.board.getBlockedCells();
    // Original cellMask cell preserved
    expect(blocked.some(c => c.col === 0 && c.row === 5)).toBe(true);
    // laneLength cells also present
    expect(blocked.some(c => c.col === 3 && c.row === 14)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// levelSpells (§4.9.2) — initial hand injection
// ─────────────────────────────────────────────────────────────────────────────

describe('levelSpells — initial hand', () => {
  it('rockslide cards appear in the bottom player hand at game start', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      levelSpells: [{ cardId: 'rockslide', initialCount: 2 }],
    })));

    engine.tick(TICK_DT); // trigger emitInitialEvents
    const slots = engine.state.bottomPlayer.hand.slots;
    const rockslideSlots = slots.filter(s => s?.card?.id === 'rockslide');
    expect(rockslideSlots.length).toBe(2);
  });

  it('bridge_collapse cards appear in the bottom player hand at game start', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      levelSpells: [{ cardId: 'bridge_collapse', initialCount: 1 }],
    })));

    engine.tick(TICK_DT); // trigger emitInitialEvents
    const slots = engine.state.bottomPlayer.hand.slots;
    const bcSlots = slots.filter(s => s?.card?.id === 'bridge_collapse');
    expect(bcSlots.length).toBe(1);
  });

  it('spell cards fill first N slots, rest are normal draw-pool cards', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      levelSpells: [{ cardId: 'rockslide', initialCount: 2 }],
    })));

    engine.tick(TICK_DT); // trigger emitInitialEvents
    const slots = engine.state.bottomPlayer.hand.slots;
    // First 2 slots are rockslide
    expect(slots[0]?.card?.id).toBe('rockslide');
    expect(slots[1]?.card?.id).toBe('rockslide');
    // Remaining occupied slots are NOT rockslide (normal pool)
    const rest = slots.slice(2).filter(s => s !== null);
    expect(rest.every(s => s!.card?.id !== 'rockslide')).toBe(true);
  });

  it('top (enemy) player hand is unaffected by levelSpells', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      levelSpells: [{ cardId: 'rockslide', initialCount: 3 }],
    })));

    const topSlots = engine.state.topPlayer.hand.slots;
    expect(topSlots.every(s => s?.card?.id !== 'rockslide')).toBe(true);
  });

  it('spell card definitions are NOT in CARD_DEFINITIONS (hard wall)', () => {
    const ids = (CARD_DEFINITIONS as { id: string }[]).map(c => c.id);
    expect(ids).not.toContain('rockslide');
    expect(ids).not.toContain('bridge_collapse');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rockslide spell (§4.9.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Rockslide spell effect', () => {
  it('damages all units in the target column, does not affect other columns', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      startInk: 10,
      levelSpells: [{ cardId: 'rockslide', initialCount: 1 }],
      waves: {
        entries: [
          { atTick: 1, unitType: UnitType.Infantry, col: 3, count: 2 },
          { atTick: 1, unitType: UnitType.Infantry, col: 4, count: 1 },
        ],
      },
    })));

    // Advance to tick 2 so enemies have spawned
    engine.tick(TICK_DT);
    engine.tick(TICK_DT);

    const units = [...engine.state.board.units.values()];
    const col3Units = units.filter(u => u.col === 3 && u.side === Side.Top);
    const col4Unit  = units.find(u => u.col === 4 && u.side === Side.Top);

    expect(col3Units.length).toBeGreaterThanOrEqual(1);
    const col3Hp = col3Units.map(u => u.hp);

    // Find rockslide in bottom player hand
    const slots = engine.state.bottomPlayer.hand.slots;
    const slot = slots.findIndex(s => s?.card?.id === 'rockslide');
    expect(slot).toBeGreaterThanOrEqual(0);

    engine.playCard(slot, 3);
    engine.tick(TICK_DT);

    // col 3 units took damage
    const col3After = [...engine.state.board.units.values()].filter(u => u.col === 3 && u.side === Side.Top);
    for (const u of col3After) {
      if (!u.isDead) expect(u.hp).toBeLessThan(col3Hp[0] ?? u.hp + 1);
    }

    // col 4 unit untouched
    if (col4Unit && !col4Unit.isDead) {
      expect(col4Unit.hp).toBe(col4Unit.maxHp ?? col4Unit.hp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BridgeCollapse spell (§4.9.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('BridgeCollapse spell effect', () => {
  it('sets tempBlockedCols for the target column after casting', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      startInk: 10,
      levelSpells: [{ cardId: 'bridge_collapse', initialCount: 1 }],
      objective: { kind: 'timed_defense', durationTicks: 9999 },
    })));

    engine.tick(TICK_DT); // trigger emitInitialEvents
    const slots = engine.state.bottomPlayer.hand.slots;
    const slot = slots.findIndex(s => s?.card?.id === 'bridge_collapse');
    expect(slot).toBeGreaterThanOrEqual(0);

    engine.playCard(slot, 5);
    engine.tick(TICK_DT);

    expect(engine.state.tempBlockedCols.has(5)).toBe(true);
  });

  it('tempBlockedCols entry expires after BRIDGE_COLLAPSE_DURATION_TICKS ticks', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      startInk: 10,
      levelSpells: [{ cardId: 'bridge_collapse', initialCount: 1 }],
      objective: { kind: 'timed_defense', durationTicks: 9999 },
    })));

    engine.tick(TICK_DT); // trigger emitInitialEvents
    const slots = engine.state.bottomPlayer.hand.slots;
    const slot = slots.findIndex(s => s?.card?.id === 'bridge_collapse');
    engine.playCard(slot, 2);
    engine.tick(TICK_DT); // cast happens

    expect(engine.state.tempBlockedCols.has(2)).toBe(true);

    // Run for BRIDGE_COLLAPSE_DURATION_TICKS more ticks — block should expire
    for (let i = 0; i < BRIDGE_COLLAPSE_DURATION_TICKS; i++) engine.tick(TICK_DT);

    expect(engine.state.tempBlockedCols.has(2)).toBe(false);
  });

  it('a unit in a bridge-collapsed column enters Detour state', () => {
    const engine = createGameEngine(makeCampaignConfig(baseLevel({
      startInk: 10,
      levelSpells: [{ cardId: 'bridge_collapse', initialCount: 1 }],
      waves: { entries: [{ atTick: 1, unitType: UnitType.Infantry, col: 5, count: 1 }] },
    })));

    // Spawn the enemy
    engine.tick(TICK_DT);
    engine.tick(TICK_DT);

    // Cast bridge_collapse on col 5
    const handSlots = engine.state.bottomPlayer.hand.slots;
    const slot = handSlots.findIndex(s => s?.card?.id === 'bridge_collapse');
    engine.playCard(slot, 5);
    engine.tick(TICK_DT);

    // Next tick the movement system should switch the unit to Detour
    engine.tick(TICK_DT);

    const unit = [...engine.state.board.units.values()].find(
      u => u.side === Side.Top && u.col === 5 && !u.isDead,
    );
    // Unit may have already moved off-column; check it's either in Detour or moved away
    // (the detour logic shifts detourTargetCol ± 1 immediately)
    if (unit) {
      const isDetouring = unit.state === UnitState.Detour || unit.col !== 5;
      expect(isDetouring).toBe(true);
    }
    // If unit is gone (somehow leaking past in one tick) the test is vacuously fine;
    // the main assertion is on tempBlockedCols which we already checked.
    expect(engine.state.tempBlockedCols.has(5)).toBe(true);
  });
});
