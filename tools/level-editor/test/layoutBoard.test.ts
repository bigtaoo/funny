// src/layout/board.ts — the board panel's PURE layer: screen<->board-cell coordinate transforms,
// cell-size fitting, path-node hit-testing, zone-tint classification (DESIGN.md §3: row 0 at the
// bottom, base columns, building/spawn rows, attack lanes vs. combat zone) and the two path
// polyline builders.
//
// These started life as private instance methods on BoardPanel reading `this.cell`/`this.header`.
// Phase 4 (2026-08-13) lifted six of them into exported free functions taking those explicitly;
// ADR-070 Phase 4b (2026-08-20) moved the whole pure half out of the canvas-owning class into
// src/layout/board.ts, so a directory-level coverage.include can reach it, and lifted the
// remaining pure decisions (fitCell / activeHandles / crossPathPoints / escortPathPoints) out of
// resize() and the draw methods on the way. BoardPanel itself is still out of scope: it builds a
// real <canvas>/ResizeObserver/window listeners in its constructor and this editor has no
// headless-DOM harness. See vitest.config.ts's scope note.
import { describe, it, expect } from 'vitest';
import { BOARD_COLS, BOARD_ROWS, BOTTOM_BUILDING_ROW, BOTTOM_SPAWN_ROW, TOP_BUILDING_ROW, TOP_SPAWN_ROW } from '@nw/engine/config';
import { UnitType } from '@nw/engine/types';
import type { EscortSpec, WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import {
  C,
  DEFAULT_CELL,
  activeHandles,
  baseTint,
  cellAt,
  cellCenter,
  crossPathPoints,
  escortPathPoints,
  fitCell,
  headerFor,
  hitHandle,
  isAttackLane,
  isBaseCol,
  laneHeaderAt,
  rowToY,
  type Handle,
} from '../src/layout/board';

const CELL = 20;
const HEADER = 14;

describe('rowToY', () => {
  it('places row 0 at the bottom of the grid (highest Y)', () => {
    expect(rowToY(0, CELL, HEADER)).toBe(HEADER + (BOARD_ROWS - 1) * CELL);
  });

  it('places the topmost row directly under the header', () => {
    expect(rowToY(BOARD_ROWS - 1, CELL, HEADER)).toBe(HEADER);
  });
});

describe('cellAt', () => {
  it('returns null inside the header strip', () => {
    expect(cellAt(5, HEADER - 1, CELL, HEADER)).toBeNull();
  });

  it('maps the first pixel of the grid area to {col:0, row: BOARD_ROWS-1} (bottom row)', () => {
    expect(cellAt(0, HEADER, CELL, HEADER)).toEqual({ col: 0, row: BOARD_ROWS - 1 });
  });

  it('maps a point in the last row/col to {col: BOARD_COLS-1, row: 0}', () => {
    const px = (BOARD_COLS - 1) * CELL + 1;
    const py = HEADER + (BOARD_ROWS - 1) * CELL + 1;
    expect(cellAt(px, py, CELL, HEADER)).toEqual({ col: BOARD_COLS - 1, row: 0 });
  });

  it('returns null past the right edge of the grid', () => {
    expect(cellAt(BOARD_COLS * CELL + 5, HEADER, CELL, HEADER)).toBeNull();
  });

  it('returns null past the bottom edge of the grid', () => {
    expect(cellAt(0, HEADER + BOARD_ROWS * CELL + 5, CELL, HEADER)).toBeNull();
  });

  it('returns null for a negative x (off the left edge)', () => {
    expect(cellAt(-5, HEADER, CELL, HEADER)).toBeNull();
  });
});

describe('laneHeaderAt', () => {
  it('returns null below the header strip', () => {
    expect(laneHeaderAt(0, HEADER, CELL, HEADER)).toBeNull();
  });

  it('returns the column when it is an attack lane', () => {
    expect(laneHeaderAt(0, 0, CELL, HEADER)).toBe(0); // col 0 is an attack lane
  });

  it('returns null when the column is a base column, not an attack lane', () => {
    expect(laneHeaderAt(5 * CELL, 0, CELL, HEADER)).toBeNull(); // col 5 is a base column
  });
});

describe('cellCenter', () => {
  it('is half a cell right of the column edge and half a cell above the row\'s bottom edge', () => {
    expect(cellCenter(0, BOARD_ROWS - 1, CELL, HEADER)).toEqual({ x: CELL / 2, y: rowToY(BOARD_ROWS - 1, CELL, HEADER) + CELL / 2 });
  });
});

describe('hitHandle', () => {
  const handles: Handle[] = [
    { kind: 'wp', k: 0, col: 0, row: BOARD_ROWS - 1 },
    { kind: 'wp', k: 1, col: 5, row: 3 },
  ];

  it('hits the handle whose cell centre the point falls within half a cell of', () => {
    const c = cellCenter(0, BOARD_ROWS - 1, CELL, HEADER);
    expect(hitHandle(c.x, c.y, CELL, HEADER, handles)).toEqual(handles[0]);
  });

  it('returns null when no handle is within range', () => {
    expect(hitHandle(-9999, -9999, CELL, HEADER, handles)).toBeNull();
  });

  it('returns null for an empty handle list', () => {
    const c = cellCenter(0, BOARD_ROWS - 1, CELL, HEADER);
    expect(hitHandle(c.x, c.y, CELL, HEADER, [])).toBeNull();
  });

  it('prefers the later (topmost-drawn) handle when two occupy the same cell', () => {
    const tied: Handle[] = [
      { kind: 'wp', k: 0, col: 2, row: 2 },
      { kind: 'wp', k: 1, col: 2, row: 2 },
    ];
    const c = cellCenter(2, 2, CELL, HEADER);
    expect(hitHandle(c.x, c.y, CELL, HEADER, tied)).toEqual(tied[1]);
  });
});

describe('baseTint', () => {
  it('tints a base column regardless of row', () => {
    expect(baseTint(5, 3)).toBe(C.base);
  });

  it('base-column check wins over a building-row match', () => {
    expect(baseTint(5, BOTTOM_BUILDING_ROW)).toBe(C.base);
  });

  it('tints the bottom (player) building row', () => {
    expect(baseTint(0, BOTTOM_BUILDING_ROW)).toBe(C.playerRow);
  });

  it('tints the bottom (player) spawn row', () => {
    expect(baseTint(0, BOTTOM_SPAWN_ROW)).toBe(C.playerSpawn);
  });

  it('tints the top (enemy) building row', () => {
    expect(baseTint(0, TOP_BUILDING_ROW)).toBe(C.enemyRow);
  });

  it('tints the top (enemy) spawn row', () => {
    expect(baseTint(0, TOP_SPAWN_ROW)).toBe(C.enemySpawn);
  });

  it('tints an attack-lane column in the combat zone as "attack"', () => {
    expect(baseTint(0, 8)).toBe(C.attack);
  });

  it('falls back to "combat" for a column outside every known set', () => {
    expect(baseTint(BOARD_COLS + 5, 8)).toBe(C.combat);
  });
});

// ── Phase 4b additions: the pure decisions that used to sit inside resize() and the draw methods ──

describe('headerFor / fitCell', () => {
  it('derives the header strip as 70% of the cell size, rounded', () => {
    expect(headerFor(20)).toBe(14);
    expect(headerFor(DEFAULT_CELL)).toBe(Math.round(DEFAULT_CELL * 0.7));
  });

  it('divides the mount width (less padding) evenly across the columns', () => {
    // 24px of board-mount padding, then floor(avail / BOARD_COLS).
    const width = 24 + 30 * BOARD_COLS;
    expect(fitCell(width)).toEqual({ cell: 30, header: headerFor(30) });
  });

  it('floors at the minimum cell size instead of collapsing on a narrow mount', () => {
    // The grid overflows a too-narrow panel rather than shrinking past MIN_CELL.
    expect(fitCell(0).cell).toBe(16);
    expect(fitCell(-9999).cell).toBe(16);
  });

  it('caps at the maximum cell size on a very wide mount', () => {
    expect(fitCell(100_000).cell).toBe(56);
  });

  it('keeps cell and header consistent at every width', () => {
    for (const w of [0, 200, 313, 700, 1024, 4000]) {
      const fit = fitCell(w);
      expect(fit.header).toBe(headerFor(fit.cell));
    }
  });
});

describe('isBaseCol / isAttackLane', () => {
  it('classifies a base column and an attack lane', () => {
    expect(isBaseCol(5)).toBe(true);
    expect(isAttackLane(5)).toBe(false);
    expect(isAttackLane(0)).toBe(true);
    expect(isBaseCol(0)).toBe(false);
  });

  it('is false for both outside the board', () => {
    expect(isBaseCol(BOARD_COLS + 5)).toBe(false);
    expect(isAttackLane(BOARD_COLS + 5)).toBe(false);
  });
});

/** activeHandles reads whole EscortSpecs off the state, so these need the game fields too;
 *  escortPathPoints takes only the route (see EscortRoute). */
function escortSpec(partial: Omit<EscortSpec, 'id' | 'hp' | 'speed'>): EscortSpec {
  return { id: 'e1', hp: 10, speed: 1, ...partial };
}

function wave(partial: Partial<WaveEntry> & Pick<WaveEntry, 'atTick' | 'col'>): WaveEntry {
  return { unitType: UnitType.Infantry, count: 1, ...partial };
}

/** The slice of EditorState that activeHandles reads. */
function handleState(over: Partial<{ selectedWave: number | null; waves: WaveEntry[]; escorts: EscortSpec[] }> = {}) {
  return { selectedWave: null, waves: [], escorts: [], ...over } as Parameters<typeof activeHandles>[1];
}

describe('activeHandles', () => {
  const withWps = wave({
    atTick: 0,
    col: 0,
    crossWaypoints: [{ atRow: 12, toCol: 3 }, { atRow: 6, toCol: 7 }],
  });
  const escort = escortSpec({ startCol: 2, startRow: 1, path: [{ col: 4, row: 5 }] });

  it('surfaces nothing for the paint tools, however much path data exists', () => {
    const state = handleState({ selectedWave: 0, waves: [withWps], escorts: [escort] });
    for (const tool of ['noBuild', 'blocked', 'erase'] as const) {
      expect(activeHandles(tool, state)).toEqual([]);
    }
  });

  it('surfaces the selected wave\'s detour waypoints for the wp tool', () => {
    expect(activeHandles('wp', handleState({ selectedWave: 0, waves: [withWps] }))).toEqual([
      { kind: 'wp', k: 0, col: 3, row: 12 },
      { kind: 'wp', k: 1, col: 7, row: 6 },
    ]);
  });

  it('surfaces nothing for the wp tool when no wave is selected', () => {
    expect(activeHandles('wp', handleState({ selectedWave: null, waves: [withWps] }))).toEqual([]);
  });

  it('surfaces nothing for a wave with no waypoints', () => {
    expect(activeHandles('wp', handleState({ selectedWave: 0, waves: [wave({ atTick: 0, col: 0 })] }))).toEqual([]);
  });

  it('surfaces every escort\'s start plus its waypoints for the escort tool, regardless of selection', () => {
    const second = escortSpec({ startCol: 8, startRow: 2 });
    expect(activeHandles('escort', handleState({ escorts: [escort, second] }))).toEqual([
      { kind: 'escortStart', i: 0, col: 2, row: 1 },
      { kind: 'escortWp', i: 0, j: 0, col: 4, row: 5 },
      { kind: 'escortStart', i: 1, col: 8, row: 2 },
    ]);
  });

  it('orders handles so hitHandle prefers a waypoint over the start cell it sits on', () => {
    // hitHandle scans backwards, so "later in the list" must mean "drawn on top".
    const stacked = escortSpec({ startCol: 2, startRow: 1, path: [{ col: 2, row: 1 }] });
    const handles = activeHandles('escort', handleState({ escorts: [stacked] }));
    const c = cellCenter(2, 1, CELL, HEADER);
    expect(hitHandle(c.x, c.y, CELL, HEADER, handles)).toEqual({ kind: 'escortWp', i: 0, j: 0, col: 2, row: 1 });
  });
});

describe('crossPathPoints', () => {
  it('runs straight down the spawn column to the base row when there are no waypoints', () => {
    expect(crossPathPoints(wave({ atTick: 0, col: 4 }))).toEqual([
      { col: 4, row: TOP_SPAWN_ROW },
      { col: 4, row: 0 },
    ]);
  });

  it('elbows per waypoint: descend in the current column to atRow, then jog to toCol', () => {
    expect(crossPathPoints(wave({
      atTick: 0,
      col: 1,
      crossWaypoints: [{ atRow: 12, toCol: 6 }, { atRow: 4, toCol: 9 }],
    }))).toEqual([
      { col: 1, row: TOP_SPAWN_ROW },
      { col: 1, row: 12 }, // descend in col 1
      { col: 6, row: 12 }, // jog to col 6
      { col: 6, row: 4 },  // descend in col 6
      { col: 9, row: 4 },  // jog to col 9
      { col: 9, row: 0 },  // continue to the base row
    ]);
  });

  it('treats an empty waypoint list the same as none at all', () => {
    expect(crossPathPoints(wave({ atTick: 0, col: 4, crossWaypoints: [] })))
      .toEqual(crossPathPoints(wave({ atTick: 0, col: 4 })));
  });
});

describe('escortPathPoints', () => {
  it('runs from the start cell straight up to the enemy building row with no waypoints', () => {
    expect(escortPathPoints({ startCol: 3, startRow: 2 })).toEqual([
      { col: 3, row: 2 },
      { col: 3, row: TOP_BUILDING_ROW },
    ]);
  });

  it('uses the same vertical-then-jog elbow as the detour path', () => {
    expect(escortPathPoints({ startCol: 3, startRow: 1, path: [{ col: 7, row: 9 }] })).toEqual([
      { col: 3, row: 1 },
      { col: 3, row: 9 },
      { col: 7, row: 9 },
      { col: 7, row: TOP_BUILDING_ROW },
    ]);
  });

  it('ends at the top building row, the mirror of the detour path ending at row 0', () => {
    const esc = escortPathPoints({ startCol: 3, startRow: 2 });
    expect(esc[esc.length - 1]!.row).toBe(TOP_BUILDING_ROW);
    const cross = crossPathPoints(wave({ atTick: 0, col: 3 }));
    expect(cross[cross.length - 1]!.row).toBe(0);
  });

  it('never emits a diagonal segment: each step changes col or row, not both', () => {
    const pts = escortPathPoints({ startCol: 0, startRow: 0, path: [{ col: 5, row: 4 }, { col: 2, row: 11 }] });
    for (let i = 1; i < pts.length; i++) {
      const same = Number(pts[i]!.col === pts[i - 1]!.col) + Number(pts[i]!.row === pts[i - 1]!.row);
      expect(same, `segment ${i - 1}->${i} is diagonal`).toBeGreaterThanOrEqual(1);
    }
  });
});
