import {
  ATTACK_LANES,
  BASE_COLS,
  BOARD_COLS,
  BOARD_ROWS,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from '@game/config';
import type { EditorState, MaskKind } from '../state/EditorState';

/**
 * Board grid panel (P-C).
 *
 * A 12×18 Canvas mirroring the game board geometry (see DESIGN.md §3): the enemy
 * (Top) side is drawn at the top, the player (Bottom) side at the bottom, so
 * row 0 maps to the lowest screen row. Zone tints make the layout legible at a
 * glance — base columns, both building/spawn rows, attack lanes vs. combat zone.
 *
 * Interaction:
 *  - Paint tool (noBuild / blocked / erase) stamps cells; click toggles, drag
 *    applies the action decided on mousedown (classic paint behaviour).
 *  - Lane headers toggle `activeLanes` for attack lanes.
 * All edits go through {@link EditorState}, which normalizes + broadcasts.
 */

const CELL = 26;
const HEADER = 18; // lane on/off header strip at the very top
const GRID_W = BOARD_COLS * CELL;
const GRID_H = BOARD_ROWS * CELL;

const C = {
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

type Tool = MaskKind | 'erase';

const BASE_COL_SET = new Set<number>(BASE_COLS as readonly number[]);
const ATTACK_SET = new Set<number>(ATTACK_LANES as readonly number[]);

export class BoardPanel {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tool: Tool = 'noBuild';
  private painting = false;
  /** Action chosen on mousedown so a drag stays consistent. */
  private dragAdds = true;

  constructor(private state: EditorState, private onToolChange?: () => void) {
    this.canvas.width = GRID_W;
    this.canvas.height = GRID_H + HEADER;
    this.canvas.style.cursor = 'pointer';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => (this.painting = false));

    state.on(() => this.render());
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.onToolChange?.();
  }
  getTool(): Tool {
    return this.tool;
  }

  /** Screen Y (within grid area) for a board row — row 0 at the bottom. */
  private rowToY(row: number): number {
    return HEADER + (BOARD_ROWS - 1 - row) * CELL;
  }

  private cellAt(px: number, py: number): { col: number; row: number } | null {
    if (py < HEADER) return null;
    const col = Math.floor(px / CELL);
    const screenRow = Math.floor((py - HEADER) / CELL);
    const row = BOARD_ROWS - 1 - screenRow;
    if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return null;
    return { col, row };
  }

  private laneHeaderAt(px: number, py: number): number | null {
    if (py >= HEADER) return null;
    const col = Math.floor(px / CELL);
    return ATTACK_SET.has(col) ? col : null;
  }

  private onDown(e: MouseEvent): void {
    const { x, y } = this.localXY(e);
    const lane = this.laneHeaderAt(x, y);
    if (lane !== null) {
      this.state.setLaneActive(lane, !this.state.isLaneActive(lane));
      return;
    }
    const cell = this.cellAt(x, y);
    if (!cell) return;
    if (this.tool === 'erase') {
      this.dragAdds = false;
      this.state.setMask('noBuild', cell.col, cell.row, false);
      this.state.setMask('blocked', cell.col, cell.row, false);
    } else {
      // Toggle on single click: decide add/remove from the cell's current state.
      this.dragAdds = !this.state.hasMask(this.tool, cell.col, cell.row);
      this.state.setMask(this.tool, cell.col, cell.row, this.dragAdds);
    }
    this.painting = true;
  }

  private onMove(e: MouseEvent): void {
    if (!this.painting) return;
    const { x, y } = this.localXY(e);
    const cell = this.cellAt(x, y);
    if (!cell) return;
    if (this.tool === 'erase') {
      this.state.setMask('noBuild', cell.col, cell.row, false);
      this.state.setMask('blocked', cell.col, cell.row, false);
    } else {
      this.state.setMask(this.tool, cell.col, cell.row, this.dragAdds);
    }
  }

  private localXY(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private baseTint(col: number, row: number): string {
    if (BASE_COL_SET.has(col)) return C.base;
    if (row === BOTTOM_BUILDING_ROW) return C.playerRow;
    if (row === BOTTOM_SPAWN_ROW) return C.playerSpawn;
    if (row === TOP_BUILDING_ROW) return C.enemyRow;
    if (row === TOP_SPAWN_ROW) return C.enemySpawn;
    if (ATTACK_SET.has(col)) return C.attack;
    return C.combat;
  }

  render(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // ── Lane on/off header ──
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let col = 0; col < BOARD_COLS; col++) {
      const x = col * CELL;
      if (ATTACK_SET.has(col)) {
        const on = this.state.isLaneActive(col);
        ctx.fillStyle = on ? C.laneOn : C.laneOff;
        ctx.fillRect(x + 2, 2, CELL - 4, HEADER - 4);
        ctx.fillStyle = on ? '#11111b' : C.dim;
        ctx.fillText(String(col), x + CELL / 2, HEADER / 2);
      } else {
        ctx.fillStyle = C.dim;
        ctx.fillText(BASE_COL_SET.has(col) ? '⌂' : '·', x + CELL / 2, HEADER / 2);
      }
    }

    // ── Cells ──
    for (let row = 0; row < BOARD_ROWS; row++) {
      for (let col = 0; col < BOARD_COLS; col++) {
        const x = col * CELL;
        const yy = this.rowToY(row);
        const laneInactive = ATTACK_SET.has(col) && !this.state.isLaneActive(col);

        ctx.fillStyle = this.baseTint(col, row);
        ctx.fillRect(x, yy, CELL, CELL);
        if (laneInactive) {
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x, yy, CELL, CELL);
        }

        if (this.state.hasMask('blocked', col, row)) this.drawBlocked(x, yy);
        if (this.state.hasMask('noBuild', col, row)) this.drawNoBuild(x, yy);

        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, yy + 0.5, CELL - 1, CELL - 1);
      }
    }
  }

  private drawNoBuild(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(249,226,175,0.22)';
    ctx.fillRect(x, y, CELL, CELL);
    ctx.strokeStyle = C.noBuild;
    ctx.lineWidth = 1.5;
    // hatch
    ctx.beginPath();
    for (let i = -CELL; i < CELL; i += 6) {
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + CELL, y + CELL);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL, CELL);
    ctx.clip();
    ctx.beginPath();
    for (let i = -CELL; i < CELL; i += 6) {
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + CELL, y + CELL);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawBlocked(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = C.blocked;
    ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
    ctx.strokeStyle = '#11111b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 6);
    ctx.lineTo(x + CELL - 6, y + CELL - 6);
    ctx.moveTo(x + CELL - 6, y + 6);
    ctx.lineTo(x + 6, y + CELL - 6);
    ctx.stroke();
  }
}
