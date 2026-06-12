import type { Cell, LevelDefinition } from '@game/campaign/LevelDefinition';
import { ATTACK_LANES } from '@game/config';

/** Cell-mask paint layers. */
export type MaskKind = 'blocked' | 'noBuild';

/**
 * Central mutable working copy of the level being edited, plus a tiny change
 * bus. Panels (board grid, future timeline / form) read `level` and call the
 * mutators; every mutator normalizes the data (drops empty arrays/objects) so
 * the exported JSON stays clean and round-trip-equivalent, then notifies
 * subscribers to re-render.
 *
 * Normalization is the reason board edits never leave a `cellMask: {}` or
 * `board: {}` husk in the JSON: removing the last painted cell removes the
 * container too, matching how a hand-authored level would look.
 */
export class EditorState {
  private listeners = new Set<() => void>();

  constructor(public level: LevelDefinition) {}

  /** Subscribe to changes; returns an unsubscribe fn. */
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Replace the whole level (e.g. after import) and notify. */
  setLevel(level: LevelDefinition): void {
    this.level = level;
    this.emit();
  }

  // ── Cell mask ──────────────────────────────────────────────────────────────

  private maskCells(kind: MaskKind): Cell[] {
    return this.level.board?.cellMask?.[kind] ?? [];
  }

  hasMask(kind: MaskKind, col: number, row: number): boolean {
    return this.maskCells(kind).some((c) => c.col === col && c.row === row);
  }

  /** Add or remove a painted cell in the given layer, then normalize + emit. */
  setMask(kind: MaskKind, col: number, row: number, on: boolean): void {
    const cells = this.maskCells(kind);
    const idx = cells.findIndex((c) => c.col === col && c.row === row);
    if (on && idx === -1) cells.push({ col, row });
    else if (!on && idx !== -1) cells.splice(idx, 1);
    else return; // no change
    this.writeMask(kind, cells);
    this.emit();
  }

  private writeMask(kind: MaskKind, cells: Cell[]): void {
    const board = this.level.board ?? {};
    const mask = board.cellMask ?? {};
    if (cells.length === 0) delete mask[kind];
    else mask[kind] = cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);

    if (Object.keys(mask).length === 0) delete board.cellMask;
    else board.cellMask = mask;

    if (board.activeLanes === undefined && board.cellMask === undefined) {
      delete this.level.board;
    } else {
      this.level.board = board;
    }
  }

  // ── Active lanes ─────────────────────────────────────────────────────────────

  /** True if `col` is currently an active attack lane (default: all active). */
  isLaneActive(col: number): boolean {
    const active = this.level.board?.activeLanes;
    return active ? active.includes(col) : true;
  }

  /** Toggle a single attack lane on/off; stores an explicit list only when it
   *  differs from "all lanes active" (else the field is dropped). */
  setLaneActive(col: number, active: boolean): void {
    const all = ATTACK_LANES as readonly number[];
    const current = new Set(this.level.board?.activeLanes ?? all);
    if (active) current.add(col);
    else current.delete(col);

    const board = this.level.board ?? {};
    const sorted = all.filter((c) => current.has(c));
    if (sorted.length === all.length) delete board.activeLanes;
    else board.activeLanes = sorted;

    if (board.activeLanes === undefined && board.cellMask === undefined) {
      delete this.level.board;
    } else {
      this.level.board = board;
    }
    this.emit();
  }
}
