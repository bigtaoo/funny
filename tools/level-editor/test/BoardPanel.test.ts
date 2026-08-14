// BoardPanel.ts's pure grid math — screen<->board-cell coordinate transforms, path-node
// hit-testing, and zone-tint classification (DESIGN.md §3: row 0 at the bottom, base columns,
// building/spawn rows, attack lanes vs. combat zone). These were private instance methods
// reading `this.cell`/`this.header`; extracted as free functions taking those explicitly
// (behavior unchanged — every call site was updated to delegate), since the class itself
// builds a real `<canvas>`/ResizeObserver/window listeners in its constructor and has no
// headless-DOM harness — see vitest.config.ts's scope note.
import { describe, it, expect } from 'vitest';
import { BOARD_COLS, BOARD_ROWS, BOTTOM_BUILDING_ROW, BOTTOM_SPAWN_ROW, TOP_BUILDING_ROW, TOP_SPAWN_ROW } from '@nw/engine/config';
import { rowToY, cellAt, laneHeaderAt, cellCenter, hitHandle, baseTint, C, type Handle } from '../src/board/BoardPanel';

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
