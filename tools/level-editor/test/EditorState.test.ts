// EditorState (src/state/EditorState.ts) — the editor's central mutable working copy of the
// level being edited. Pure logic: no PIXI/DOM dependency, only reads/writes a plain
// LevelDefinition object and notifies subscribers. Covers the coordinate clamps, the
// crossWaypoint/escort/wave/hazard/mask/lane CRUD, and every normalization rule that keeps
// exported JSON free of empty-container husks (per the class doc comment).
import { describe, it, expect, vi } from 'vitest';
import type { LevelDefinition } from '@nw/engine/campaign/LevelDefinition';
import { EditorState } from '../src/state/EditorState';

// ATTACK_LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11], BOARD_ROWS = 18 (server/engine/src/config.ts).

function makeLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'ch1_lv1',
    chapter: 1,
    seed: 42,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  };
}

describe('subscription (on/touch/emit)', () => {
  it('notifies subscribers on any mutation, and unsubscribe stops further notifications', () => {
    const state = new EditorState(makeLevel());
    const fn = vi.fn();
    const off = state.on(fn);
    state.selectWave(null); // any mutator triggers emit
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    state.selectWave(0); // no-op mutation but still emits before unsubscribe check — verify it does NOT fire after off()
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('touch() re-notifies subscribers without mutating anything itself', () => {
    const state = new EditorState(makeLevel());
    const fn = vi.fn();
    state.on(fn);
    state.touch();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('setLevel() replaces the level, clears wave/escort selection, and notifies', () => {
    const state = new EditorState(makeLevel());
    state.selectWave(0);
    state.selectEscort(0);
    const fn = vi.fn();
    state.on(fn);
    const next = makeLevel({ id: 'ch1_lv2' });
    state.setLevel(next);
    expect(state.level).toBe(next);
    expect(state.selectedWave).toBeNull();
    expect(state.selectedEscort).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('crossWaypoints (selected wave)', () => {
  it('addCrossWaypoint is a no-op when no wave is selected', () => {
    const state = new EditorState(makeLevel({ waves: { entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1 }] } }));
    state.addCrossWaypoint(5, 5);
    expect(state.waves[0]!.crossWaypoints).toBeUndefined();
  });

  it('addCrossWaypoint snaps the column to the nearest attack lane and clamps the row', () => {
    const state = new EditorState(makeLevel({ waves: { entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1 }] } }));
    state.selectWave(0);
    state.addCrossWaypoint(6, -3); // col 6 is closer to lane 7 than lane 4; row clamps to 0
    expect(state.waves[0]!.crossWaypoints).toEqual([{ atRow: 0, toCol: 7 }]);
    state.addCrossWaypoint(5, 99); // col 5 is closer to lane 4 (tie-break goes to the lower lane); row clamps to 17
    expect(state.waves[0]!.crossWaypoints).toEqual([
      { atRow: 0, toCol: 7 },
      { atRow: 17, toCol: 4 },
    ]);
  });

  it('updateCrossWaypoint moves the k-th waypoint; no-op for an out-of-range k', () => {
    const state = new EditorState(
      makeLevel({ waves: { entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1, crossWaypoints: [{ atRow: 2, toCol: 1 }] }] } }),
    );
    state.selectWave(0);
    state.updateCrossWaypoint(0, 9, 10);
    expect(state.waves[0]!.crossWaypoints).toEqual([{ atRow: 10, toCol: 9 }]);
    state.updateCrossWaypoint(5, 0, 0); // no entry at index 5
    expect(state.waves[0]!.crossWaypoints).toEqual([{ atRow: 10, toCol: 9 }]);
  });

  it('removeCrossWaypoint deletes the k-th entry; leaves the array (not deleted) when others remain', () => {
    const state = new EditorState(
      makeLevel({
        waves: {
          entries: [
            {
              atTick: 0,
              unitType: 'infantry' as any,
              col: 0,
              count: 1,
              crossWaypoints: [{ atRow: 2, toCol: 1 }, { atRow: 4, toCol: 3 }],
            },
          ],
        },
      }),
    );
    state.selectWave(0);
    state.removeCrossWaypoint(0);
    expect(state.waves[0]!.crossWaypoints).toEqual([{ atRow: 4, toCol: 3 }]);
  });
});

describe('escorts', () => {
  it('selectEscort clears to null for an out-of-range index, keeps a valid one', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0 }] }));
    state.selectEscort(0);
    expect(state.selectedEscort).toBe(0);
    state.selectEscort(3);
    expect(state.selectedEscort).toBeNull();
    state.selectEscort(null);
    expect(state.selectedEscort).toBeNull();
  });

  it('setEscortStart snaps col to the nearest lane and clamps row; no-op for a missing escort', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0 }] }));
    state.setEscortStart(0, 6, 30);
    expect(state.escorts[0]).toMatchObject({ startCol: 7, startRow: 17 });
    state.setEscortStart(5, 1, 1); // no escort at index 5
    expect(state.escorts).toHaveLength(1);
  });

  it('addEscortWaypoint requires strictly-ascending rows past the last point (or startRow with an empty path)', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 5 }] }));
    expect(state.addEscortWaypoint(0, 1, 5)).toBe(false); // equal to startRow, not an advance
    expect(state.addEscortWaypoint(0, 1, 4)).toBe(false); // behind startRow
    expect(state.addEscortWaypoint(0, 1, 8)).toBe(true);
    expect(state.escorts[0]!.path).toEqual([{ col: 1, row: 8 }]);
    expect(state.addEscortWaypoint(0, 2, 8)).toBe(false); // equal to the last waypoint's row
    expect(state.addEscortWaypoint(0, 2, 9)).toBe(true);
    expect(state.escorts[0]!.path).toEqual([
      { col: 1, row: 8 },
      { col: 2, row: 9 },
    ]);
  });

  it('addEscortWaypoint returns false for a missing escort', () => {
    const state = new EditorState(makeLevel({ escorts: [] }));
    expect(state.addEscortWaypoint(0, 1, 5)).toBe(false);
  });

  it('updateEscortWaypoint clamps the row into the open interval between its neighbours, always updates col', () => {
    const state = new EditorState(
      makeLevel({
        escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0, path: [{ col: 1, row: 5 }, { col: 2, row: 10 }] }],
      }),
    );
    // Middle-ish waypoint 0: bounded by startRow(0)+1=1 .. path[1].row(10)-1=9.
    state.updateEscortWaypoint(0, 0, 9, 20); // row clamps down to 9
    expect(state.escorts[0]!.path![0]).toEqual({ col: 9, row: 9 });
    state.updateEscortWaypoint(0, 0, 3, -5); // row clamps up to lo=1
    expect(state.escorts[0]!.path![0]).toEqual({ col: 3, row: 1 });
  });

  it('updateEscortWaypoint updates col even when neighbours leave no room for the row (lo > hi)', () => {
    const state = new EditorState(
      makeLevel({
        escorts: [
          {
            id: 'e1',
            hp: 10,
            speed: 1,
            startCol: 0,
            startRow: 5,
            path: [{ col: 1, row: 6 }, { col: 2, row: 7 }, { col: 3, row: 8 }],
          },
        ],
      }),
    );
    // Waypoint 1: lo = path[0].row+1 = 7, hi = path[2].row-1 = 7 → still room (lo<=hi), pins to 7.
    state.updateEscortWaypoint(0, 1, 9, 100);
    expect(state.escorts[0]!.path![1]).toEqual({ col: 9, row: 7 });
  });

  it('updateEscortWaypoint is a no-op for a missing escort or out-of-range waypoint index', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0, path: [{ col: 1, row: 5 }] }] }));
    state.updateEscortWaypoint(0, 3, 1, 1); // no waypoint at index 3
    state.updateEscortWaypoint(9, 0, 1, 1); // no escort at index 9
    expect(state.escorts[0]!.path).toEqual([{ col: 1, row: 5 }]);
  });

  it('removeEscortWaypoint deletes the j-th point and drops an emptied path array entirely', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0, path: [{ col: 1, row: 5 }] }] }));
    state.removeEscortWaypoint(0, 0);
    expect(state.escorts[0]!.path).toBeUndefined();
  });

  it('removeEscortWaypoint guards bounds and a missing escort', () => {
    const state = new EditorState(makeLevel({ escorts: [{ id: 'e1', hp: 10, speed: 1, startCol: 0, startRow: 0, path: [{ col: 1, row: 5 }] }] }));
    state.removeEscortWaypoint(0, -1);
    state.removeEscortWaypoint(0, 5);
    state.removeEscortWaypoint(9, 0);
    expect(state.escorts[0]!.path).toEqual([{ col: 1, row: 5 }]);
  });
});

describe('waves', () => {
  it('addWave appends, selects the new entry, and returns its index', () => {
    const state = new EditorState(makeLevel());
    const idx = state.addWave({ atTick: 10, unitType: 'infantry' as any, col: 0, count: 1 });
    expect(idx).toBe(0);
    expect(state.selectedWave).toBe(0);
    expect(state.waves).toHaveLength(1);
  });

  it('updateWave normalizes spacingTicks=0/undefined, isBoss=false/undefined, and empty crossWaypoints away', () => {
    const state = new EditorState(
      makeLevel({
        waves: {
          entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1, spacingTicks: 2, isBoss: true, crossWaypoints: [{ atRow: 1, toCol: 1 }] }],
        },
      }),
    );
    state.updateWave(0, { spacingTicks: 0, isBoss: false, crossWaypoints: [] });
    expect(state.waves[0]).toEqual({ atTick: 0, unitType: 'infantry', col: 0, count: 1 });
  });

  it('updateWave keeps non-default values, is a no-op for an out-of-range index', () => {
    const state = new EditorState(makeLevel({ waves: { entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1 }] } }));
    state.updateWave(0, { spacingTicks: 3, isBoss: true });
    expect(state.waves[0]).toMatchObject({ spacingTicks: 3, isBoss: true });
    state.updateWave(5, { count: 99 });
    expect(state.waves).toHaveLength(1);
  });

  it('removeWave fixes up the selection: exact match clears, later selection decrements, earlier is untouched', () => {
    const entries = [0, 1, 2].map((i) => ({ atTick: i, unitType: 'infantry' as any, col: 0, count: 1 }));
    const state = new EditorState(makeLevel({ waves: { entries: [...entries] } }));

    state.selectWave(2);
    state.removeWave(1); // remove the earlier wave; selection (2) is after it → decrements to 1
    expect(state.selectedWave).toBe(1);
    expect(state.waves).toHaveLength(2);

    state.selectWave(1);
    state.removeWave(1); // remove exactly the selected wave → clears
    expect(state.selectedWave).toBeNull();
  });

  it('removeWave is a no-op for an out-of-range index', () => {
    const state = new EditorState(makeLevel({ waves: { entries: [{ atTick: 0, unitType: 'infantry' as any, col: 0, count: 1 }] } }));
    state.removeWave(9);
    expect(state.waves).toHaveLength(1);
  });
});

describe('hazards', () => {
  it('addHazard lazily creates the array', () => {
    const state = new EditorState(makeLevel());
    state.addHazard({ col: 0, rowRange: [0, 5], effect: 'lava', dps: 5 });
    expect(state.hazards).toHaveLength(1);
  });

  it('updateHazard drops effect-specific params that no longer apply to the (possibly changed) effect', () => {
    const state = new EditorState(makeLevel({ hazards: [{ col: 0, rowRange: [0, 5], effect: 'speed', speedMult: 0.5 }] }));
    state.updateHazard(0, { effect: 'lava', dps: 3 });
    expect(state.hazards[0]).toEqual({ col: 0, rowRange: [0, 5], effect: 'lava', dps: 3 });
  });

  it('updateHazard is a no-op for an out-of-range index', () => {
    const state = new EditorState(makeLevel({ hazards: [] }));
    state.updateHazard(0, { dps: 1 });
    expect(state.hazards).toHaveLength(0);
  });

  it('removeHazard deletes the whole `hazards` field once the array empties out', () => {
    const state = new EditorState(makeLevel({ hazards: [{ col: 0, rowRange: [0, 5], effect: 'lava', dps: 5 }] }));
    state.removeHazard(0);
    expect(state.level.hazards).toBeUndefined();
    expect(state.hazards).toEqual([]); // getter still returns [] via the `?? []` fallback
  });

  it('removeHazard guards out-of-range indices and a missing array', () => {
    const state = new EditorState(makeLevel());
    state.removeHazard(0); // no hazards array at all
    const withOne = new EditorState(makeLevel({ hazards: [{ col: 0, rowRange: [0, 5], effect: 'lava' }] }));
    withOne.removeHazard(9);
    expect(withOne.hazards).toHaveLength(1);
  });
});

describe('cell mask', () => {
  it('setMask toggles a cell on/off, keeps the layer sorted by row then col, and cleans up empty containers', () => {
    const state = new EditorState(makeLevel());
    state.setMask('blocked', 3, 1, true);
    state.setMask('blocked', 1, 0, true);
    expect(state.level.board!.cellMask!.blocked).toEqual([
      { col: 1, row: 0 },
      { col: 3, row: 1 },
    ]);
    expect(state.hasMask('blocked', 3, 1)).toBe(true);
    expect(state.hasMask('blocked', 9, 9)).toBe(false);

    state.setMask('blocked', 1, 0, false);
    state.setMask('blocked', 3, 1, false);
    // Both cells removed → the layer, cellMask, and (with no activeLanes either) board itself all drop out.
    expect(state.level.board).toBeUndefined();
  });

  it('setMask is a no-op when the requested on/off state already holds', () => {
    const state = new EditorState(makeLevel());
    const fn = vi.fn();
    state.on(fn);
    state.setMask('noBuild', 0, 0, false); // already off
    expect(fn).not.toHaveBeenCalled();
  });

  it('setMask leaves activeLanes intact while cellMask empties out', () => {
    const state = new EditorState(makeLevel({ board: { activeLanes: [0, 1], cellMask: { blocked: [{ col: 0, row: 0 }] } } }));
    state.setMask('blocked', 0, 0, false);
    expect(state.level.board).toEqual({ activeLanes: [0, 1] });
  });
});

describe('active lanes', () => {
  it('isLaneActive defaults to true for every lane when activeLanes is unset', () => {
    const state = new EditorState(makeLevel());
    expect(state.isLaneActive(0)).toBe(true);
    expect(state.isLaneActive(11)).toBe(true);
  });

  it('setLaneActive stores an explicit subset, sorted by ATTACK_LANES order', () => {
    const state = new EditorState(makeLevel());
    state.setLaneActive(7, false);
    state.setLaneActive(0, false);
    expect(state.level.board!.activeLanes).toEqual([1, 2, 3, 4, 8, 9, 10, 11]);
    expect(state.isLaneActive(0)).toBe(false);
    expect(state.isLaneActive(1)).toBe(true);
  });

  it('setLaneActive drops the field entirely once every lane is active again (back to the "all" default)', () => {
    const state = new EditorState(makeLevel({ board: { activeLanes: [1, 2, 3, 4, 7, 8, 9, 10, 11] } }));
    state.setLaneActive(0, true); // re-adds the missing lane → full set again
    expect(state.level.board).toBeUndefined();
  });
});
