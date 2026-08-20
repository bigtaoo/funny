import { BOARD_COLS, BOARD_ROWS, TOP_SPAWN_ROW } from '@nw/engine/config';
import type { EditorState } from '../state/EditorState';
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
  type Pt,
  type Tool,
} from '../layout/board';

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
 *
 * This class is the DOM/canvas half only: it owns the `<canvas>`, the
 * ResizeObserver and the window listeners, and delegates every coordinate
 * transform, hit test, tint lookup and path-polyline decision to the pure
 * `../layout/board` module (ADR-070 Phase 4b) — which is where the tests live.
 */

/** Path-overlay palette. Detours echo the enemy theme (pink), escorts the green
 *  in-game diamond; both dim to dashed context lines when their tool is inactive. */
const PATH = {
  cross: '#f38ba8',
  crossDim: 'rgba(243,139,168,0.42)',
  escort: ['#a6e3a1', '#94e2d5', '#89dceb', '#f9e2af', '#cba6f7'],
  escortDim: 'rgba(166,227,161,0.4)',
  handleStroke: '#11111b',
};

export class BoardPanel {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tool: Tool = 'noBuild';
  private painting = false;
  /** Path node currently being dragged (wp / escort tools). */
  private dragHandle: Handle | null = null;
  /** Action chosen on mousedown so a drag stays consistent. */
  private dragAdds = true;
  /** Current cell size in px; recomputed from the mount width on resize. */
  private cell = DEFAULT_CELL;
  /** Lane on/off header strip height in px (derived from {@link cell}). */
  private header = headerFor(DEFAULT_CELL);
  private ro: ResizeObserver;

  constructor(private state: EditorState, private mount: HTMLElement, private onToolChange?: () => void) {
    this.canvas.style.cursor = 'pointer';
    this.canvas.style.display = 'block';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    mount.appendChild(this.canvas);

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));
    window.addEventListener('mouseup', () => {
      this.painting = false;
      this.dragHandle = null;
    });

    // Grow/shrink the grid to fill the (resizable) board panel, redrawing at a
    // crisp 1:1 backing resolution so clicks map exactly to cells.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(mount);
    state.on(() => this.render());
    this.resize();
  }

  /** Fit the canvas to the mount width: pick a cell size, size the backing
   *  store 1:1 with its display size, then redraw. Public so the splitter drag
   *  can refit synchronously (the ResizeObserver covers window resizes). */
  resize(): void {
    const fit = fitCell(this.mount.clientWidth);
    this.cell = fit.cell;
    this.header = fit.header;
    const w = BOARD_COLS * this.cell;
    const h = BOARD_ROWS * this.cell + this.header;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.render();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.canvas.style.cursor = tool === 'wp' || tool === 'escort' ? 'crosshair' : 'pointer';
    this.render(); // overlays gain handles / brighten when their tool activates
    this.onToolChange?.();
  }
  getTool(): Tool {
    return this.tool;
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const { x, y } = this.localXY(e);
    if (this.tool === 'wp' || this.tool === 'escort') {
      this.onPathDown(x, y);
      return;
    }
    const lane = laneHeaderAt(x, y, this.cell, this.header);
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
    } else if (this.tool === 'noBuild' || this.tool === 'blocked') {
      // Toggle on single click: decide add/remove from the cell's current state.
      this.dragAdds = !this.state.hasMask(this.tool, cell.col, cell.row);
      this.state.setMask(this.tool, cell.col, cell.row, this.dragAdds);
    }
    this.painting = true;
  }

  private onMove(e: MouseEvent): void {
    const { x, y } = this.localXY(e);
    if (this.dragHandle) {
      this.onPathDrag(x, y);
      return;
    }
    if (!this.painting) return;
    const cell = this.cellAt(x, y);
    if (!cell) return;
    if (this.tool === 'erase') {
      this.state.setMask('noBuild', cell.col, cell.row, false);
      this.state.setMask('blocked', cell.col, cell.row, false);
    } else if (this.tool === 'noBuild' || this.tool === 'blocked') {
      this.state.setMask(this.tool, cell.col, cell.row, this.dragAdds);
    }
  }

  private localXY(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ── thin `this`-bound wrappers over the pure layout module ─────────────────

  private cellAt(px: number, py: number): { col: number; row: number } | null {
    return cellAt(px, py, this.cell, this.header);
  }

  private cellCenter(col: number, row: number): { x: number; y: number } {
    return cellCenter(col, row, this.cell, this.header);
  }

  /** Nearest path node under the cursor (within half a cell), topmost first. */
  private hitHandle(px: number, py: number): Handle | null {
    return hitHandle(px, py, this.cell, this.header, activeHandles(this.tool, this.state));
  }

  // ── Path editing (crossWaypoints / escort paths) ───────────────────────────

  private onPathDown(x: number, y: number): void {
    const hit = this.hitHandle(x, y);
    if (this.tool === 'wp') {
      if (hit && hit.kind === 'wp') {
        this.dragHandle = hit;
        return;
      }
      const cell = this.cellAt(x, y);
      if (cell && this.state.selectedWave !== null) this.state.addCrossWaypoint(cell.col, cell.row);
      return;
    }
    // escort tool
    if (hit && (hit.kind === 'escortStart' || hit.kind === 'escortWp')) {
      this.state.selectEscort(hit.i);
      this.dragHandle = hit;
      return;
    }
    const cell = this.cellAt(x, y);
    if (!cell) return;
    if (this.state.selectedEscort === null) {
      // First click with the escort tool latches onto an escort to edit.
      if (this.state.escorts.length > 0) this.state.selectEscort(0);
      return;
    }
    this.state.addEscortWaypoint(this.state.selectedEscort, cell.col, cell.row);
  }

  private onPathDrag(x: number, y: number): void {
    const cell = this.cellAt(x, y);
    if (!cell) return;
    const h = this.dragHandle!;
    if (h.kind === 'wp') this.state.updateCrossWaypoint(h.k, cell.col, cell.row);
    else if (h.kind === 'escortStart') this.state.setEscortStart(h.i, cell.col, cell.row);
    else this.state.updateEscortWaypoint(h.i, h.j, cell.col, cell.row);
  }

  private onContext(e: MouseEvent): void {
    if (this.tool !== 'wp' && this.tool !== 'escort') return;
    e.preventDefault();
    const { x, y } = this.localXY(e);
    const hit = this.hitHandle(x, y);
    if (!hit) return;
    if (hit.kind === 'wp') this.state.removeCrossWaypoint(hit.k);
    else if (hit.kind === 'escortWp') this.state.removeEscortWaypoint(hit.i, hit.j);
    // escortStart is removed by deleting the escort in the form, not here.
  }

  render(): void {
    const ctx = this.ctx;
    const cell = this.cell;
    const header = this.header;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // ── Lane on/off header ──
    ctx.font = `${Math.max(9, Math.round(cell * 0.4))}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let col = 0; col < BOARD_COLS; col++) {
      const x = col * cell;
      if (isAttackLane(col)) {
        const on = this.state.isLaneActive(col);
        ctx.fillStyle = on ? C.laneOn : C.laneOff;
        ctx.fillRect(x + 2, 2, cell - 4, header - 4);
        ctx.fillStyle = on ? '#11111b' : C.dim;
        ctx.fillText(String(col), x + cell / 2, header / 2);
      } else {
        ctx.fillStyle = C.dim;
        ctx.fillText(isBaseCol(col) ? '⌂' : '·', x + cell / 2, header / 2);
      }
    }

    // ── Cells ──
    for (let row = 0; row < BOARD_ROWS; row++) {
      for (let col = 0; col < BOARD_COLS; col++) {
        const x = col * cell;
        const yy = rowToY(row, cell, header);
        const laneInactive = isAttackLane(col) && !this.state.isLaneActive(col);

        ctx.fillStyle = baseTint(col, row);
        ctx.fillRect(x, yy, cell, cell);
        if (laneInactive) {
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x, yy, cell, cell);
        }

        if (this.state.hasMask('blocked', col, row)) this.drawBlocked(x, yy);
        if (this.state.hasMask('noBuild', col, row)) this.drawNoBuild(x, yy);

        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, yy + 0.5, cell - 1, cell - 1);
      }
    }

    this.drawPaths();
  }

  // ── Path overlays ──────────────────────────────────────────────────────────

  /** Draw the selected wave's detour path and every escort path. Each is a faint
   *  dashed context line until its tool is active, when it gains solid lines and
   *  draggable node handles. */
  private drawPaths(): void {
    this.drawCrossPath();
    this.drawEscortPaths();
  }

  /** Selected wave: spawn at TOP_SPAWN_ROW, elbow down through each waypoint,
   *  continue to base (polyline from {@link crossPathPoints}). */
  private drawCrossPath(): void {
    const idx = this.state.selectedWave;
    const entry = idx !== null ? this.state.waves[idx] : null;
    if (!entry) return;
    const active = this.tool === 'wp';

    this.strokePath(crossPathPoints(entry), active ? PATH.cross : PATH.crossDim, active ? 2.5 : 1.5, !active);
    this.drawSpawnMarker(entry.col, TOP_SPAWN_ROW, active ? PATH.cross : PATH.crossDim, -1);
    (entry.crossWaypoints ?? []).forEach((wp, k) => {
      if (active) this.drawHandle(wp.toCol, wp.atRow, PATH.cross, String(k + 1));
      else this.drawNode(wp.toCol, wp.atRow, PATH.crossDim);
    });
  }

  /** Every escort: spawn → vertical-then-jog through waypoints → arrive at top. */
  private drawEscortPaths(): void {
    const active = this.tool === 'escort';
    this.state.escorts.forEach((esc, i) => {
      const sel = active && this.state.selectedEscort === i;
      const base = PATH.escort[i % PATH.escort.length]!;
      const color = active ? base : PATH.escortDim;

      this.strokePath(escortPathPoints(esc), color, sel ? 2.5 : active ? 1.8 : 1.5, !active);
      this.drawSpawnMarker(esc.startCol, esc.startRow, color, 1);
      (esc.path ?? []).forEach((wp, j) => {
        if (active) this.drawHandle(wp.col, wp.row, base, sel ? String(j + 1) : undefined);
        else this.drawNode(wp.col, wp.row, color);
      });
    });
  }

  private strokePath(pts: Pt[], color: string, width: number, dash: boolean): void {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    const p0 = this.cellCenter(pts[0]!.col, pts[0]!.row);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = this.cellCenter(pts[i]!.col, pts[i]!.row);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Small triangle at a spawn point, pointing in travel direction (dir: -1 up
   *  the screen for descending enemies, +1 down for ascending escorts). */
  private drawSpawnMarker(col: number, row: number, color: string, dir: 1 | -1): void {
    const ctx = this.ctx;
    const { x, y } = this.cellCenter(col, row);
    const s = Math.max(4, this.cell * 0.22);
    // Enemies descend (toward the bottom of the screen): point down → screen +y.
    // Escorts ascend (toward the top): point up → screen -y.
    const ty = dir === -1 ? y + s : y - s;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, ty);
    ctx.lineTo(x - s, ty + (dir === -1 ? -s : s));
    ctx.lineTo(x + s, ty + (dir === -1 ? -s : s));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Filled draggable node with an optional ordinal label. */
  private drawHandle(col: number, row: number, color: string, label?: string): void {
    const ctx = this.ctx;
    const { x, y } = this.cellCenter(col, row);
    const r = Math.max(6, this.cell * 0.32);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PATH.handleStroke;
    ctx.stroke();
    if (label) {
      ctx.fillStyle = PATH.handleStroke;
      ctx.font = `${Math.max(9, Math.round(r))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 0.5);
    }
  }

  /** Tiny non-interactive dot marking a node when the path is dimmed context. */
  private drawNode(col: number, row: number, color: string): void {
    const ctx = this.ctx;
    const { x, y } = this.cellCenter(col, row);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, this.cell * 0.16), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawNoBuild(x: number, y: number): void {
    const ctx = this.ctx;
    const cell = this.cell;
    ctx.fillStyle = 'rgba(249,226,175,0.22)';
    ctx.fillRect(x, y, cell, cell);
    ctx.strokeStyle = C.noBuild;
    ctx.lineWidth = 1.5;
    // hatch
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cell, cell);
    ctx.clip();
    ctx.beginPath();
    for (let i = -cell; i < cell; i += 6) {
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + cell, y + cell);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawBlocked(x: number, y: number): void {
    const ctx = this.ctx;
    const cell = this.cell;
    ctx.fillStyle = C.blocked;
    ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
    ctx.strokeStyle = '#11111b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 6);
    ctx.lineTo(x + cell - 6, y + cell - 6);
    ctx.moveTo(x + cell - 6, y + 6);
    ctx.lineTo(x + 6, y + cell - 6);
    ctx.stroke();
  }
}
