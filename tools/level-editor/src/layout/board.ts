import {
  ATTACK_LANES,
  BASE_COLS,
  BOARD_COLS,
  BOARD_ROWS,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from '@nw/engine/config';
import type { EscortSpec, WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import type { EditorState, MaskKind } from '../state/EditorState';

/**
 * Board panel layout — the PURE half of `board/BoardPanel.ts` (ADR-070 Phase 4b).
 *
 * Answers, for the 12x18 board grid (DESIGN.md §3): given a cell size and header
 * height, where does a board cell sit on screen, what is under the cursor, what
 * zone colour is a cell drawn in, and which polyline does a wave/escort path
 * trace. No canvas, no DOM, no `this` — {@link BoardPanel} owns the `<canvas>`,
 * the ResizeObserver and the window listeners, and delegates every one of these
 * decisions here.
 *
 * Screen convention: the enemy (Top) side is drawn at the top and the player
 * (Bottom) side at the bottom, so board row 0 maps to the LOWEST screen row.
 */

/** Cell size the grid starts at, before the first {@link fitCell}. */
export const DEFAULT_CELL = 26;
const MIN_CELL = 16;
const MAX_CELL = 56;
const PADDING = 24; // board-mount horizontal padding (12px each side)
/** Header strip height as a fraction of cell size (lane on/off toggles). */
const HEADER_RATIO = 0.7;

/** Lane on/off header strip height for a given cell size. */
export function headerFor(cell: number): number {
  return Math.round(cell * HEADER_RATIO);
}

/** Zone/UI palette. Data, not drawing: {@link baseTint} returns entries from it,
 *  and the canvas half reads the rest (grid lines, lane toggles, mask glyphs). */
export const C = {
  grid: '#3a3a58',
  combat: '#222234',
  attack: '#26263c',
  base: '#3a3420',
  baseLine: '#6e5a2a',
  playerRow: '#1e2c3a',
  playerSpawn: '#243a4e',
  enemyRow: '#3a1e26',
  enemySpawn: '#4e2430',
  noBuild: '#f9e2af',
  blocked: '#6c7086',
  laneOn: '#a6e3a1',
  laneOff: '#45455e',
  text: '#cdd6f4',
  dim: '#6e6e8a',
};

/** The board's active tool. `wp`/`escort` are the path tools (they surface
 *  draggable {@link Handle}s); the rest paint masks. */
export type Tool = MaskKind | 'erase' | 'wp' | 'escort';

/** A draggable path node surfaced by the active path tool. */
export type Handle =
  | { kind: 'wp'; k: number; col: number; row: number }
  | { kind: 'escortStart'; i: number; col: number; row: number }
  | { kind: 'escortWp'; i: number; j: number; col: number; row: number };

/** A board cell referenced by a path polyline. */
export interface Pt {
  col: number;
  row: number;
}

/** The only part of an {@link EscortSpec} a path polyline depends on (its id/hp/
 *  speed are the game's business, not the board's). */
export type EscortRoute = Pick<EscortSpec, 'startCol' | 'startRow' | 'path'>;

const BASE_COL_SET = new Set<number>(BASE_COLS as readonly number[]);
const ATTACK_SET = new Set<number>(ATTACK_LANES as readonly number[]);

/** True for a base column (drawn as a base tint, no lane toggle). */
export function isBaseCol(col: number): boolean {
  return BASE_COL_SET.has(col);
}

/** True for an attack lane (has a lane on/off toggle in the header strip). */
export function isAttackLane(col: number): boolean {
  return ATTACK_SET.has(col);
}

/** Fit the grid to a mount width: pick a clamped cell size and derive the header
 *  height. Never narrower than {@link MIN_CELL} per column even if the mount is,
 *  so the grid overflows rather than collapsing. */
export function fitCell(mountWidth: number): { cell: number; header: number } {
  const avail = Math.max(MIN_CELL * BOARD_COLS, mountWidth - PADDING);
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(avail / BOARD_COLS)));
  return { cell, header: headerFor(cell) };
}

/** Screen Y (within grid area) for a board row — row 0 at the bottom. */
export function rowToY(row: number, cell: number, header: number): number {
  return header + (BOARD_ROWS - 1 - row) * cell;
}

export function cellAt(px: number, py: number, cell: number, header: number): { col: number; row: number } | null {
  if (py < header) return null;
  const col = Math.floor(px / cell);
  const screenRow = Math.floor((py - header) / cell);
  const row = BOARD_ROWS - 1 - screenRow;
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return null;
  return { col, row };
}

export function laneHeaderAt(px: number, py: number, cell: number, header: number): number | null {
  if (py >= header) return null;
  const col = Math.floor(px / cell);
  return ATTACK_SET.has(col) ? col : null;
}

/** Screen centre of a board cell. */
export function cellCenter(col: number, row: number, cell: number, header: number): { x: number; y: number } {
  return { x: col * cell + cell / 2, y: rowToY(row, cell, header) + cell / 2 };
}

/** Nearest path node under the cursor (within half a cell), topmost first. */
export function hitHandle(px: number, py: number, cell: number, header: number, handles: Handle[]): Handle | null {
  const r = cell * 0.5;
  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i]!;
    const c = cellCenter(h.col, h.row, cell, header);
    if (Math.hypot(px - c.x, py - c.y) <= r) return h;
  }
  return null;
}

/** Zone tint for a board cell (base column, building/spawn rows, attack lane, or combat). */
export function baseTint(col: number, row: number): string {
  if (BASE_COL_SET.has(col)) return C.base;
  if (row === BOTTOM_BUILDING_ROW) return C.playerRow;
  if (row === BOTTOM_SPAWN_ROW) return C.playerSpawn;
  if (row === TOP_BUILDING_ROW) return C.enemyRow;
  if (row === TOP_SPAWN_ROW) return C.enemySpawn;
  if (ATTACK_SET.has(col)) return C.attack;
  return C.combat;
}

/** Draggable nodes for the active path tool (none for the paint tools): the
 *  selected wave's detour waypoints, or every escort's start + waypoints. */
export function activeHandles(
  tool: Tool,
  state: Pick<EditorState, 'selectedWave' | 'waves' | 'escorts'>,
): Handle[] {
  const out: Handle[] = [];
  if (tool === 'wp') {
    const idx = state.selectedWave;
    const entry = idx !== null ? state.waves[idx] : null;
    entry?.crossWaypoints?.forEach((wp, k) => out.push({ kind: 'wp', k, col: wp.toCol, row: wp.atRow }));
  } else if (tool === 'escort') {
    state.escorts.forEach((esc, i) => {
      out.push({ kind: 'escortStart', i, col: esc.startCol, row: esc.startRow });
      esc.path?.forEach((wp, j) => out.push({ kind: 'escortWp', i, j, col: wp.col, row: wp.row }));
    });
  }
  return out;
}

/** A wave's detour polyline: spawn at TOP_SPAWN_ROW, then elbow down through
 *  each waypoint (descend in the current col to `atRow`, then jog to `toCol`),
 *  and finally continue to the base row. */
export function crossPathPoints(entry: WaveEntry): Pt[] {
  const pts: Pt[] = [{ col: entry.col, row: TOP_SPAWN_ROW }];
  let cur = entry.col;
  for (const wp of entry.crossWaypoints ?? []) {
    pts.push({ col: cur, row: wp.atRow });
    pts.push({ col: wp.toCol, row: wp.atRow });
    cur = wp.toCol;
  }
  pts.push({ col: cur, row: 0 });
  return pts;
}

/** An escort's polyline: its start cell, the same vertical-then-jog elbows
 *  through its waypoints, then up to the enemy building row it delivers to. */
export function escortPathPoints(esc: EscortRoute): Pt[] {
  const pts: Pt[] = [{ col: esc.startCol, row: esc.startRow }];
  let cur = esc.startCol;
  for (const wp of esc.path ?? []) {
    pts.push({ col: cur, row: wp.row });
    pts.push({ col: wp.col, row: wp.row });
    cur = wp.col;
  }
  pts.push({ col: cur, row: TOP_BUILDING_ROW });
  return pts;
}
