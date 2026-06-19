import type { Cell, EscortSpec, HazardSpec, LevelDefinition, WaveEntry } from '@game/campaign/LevelDefinition';
import { ATTACK_LANES, BOARD_ROWS } from '@game/config';

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

  /** Index of the selected wave entry (UI state, not serialized). */
  selectedWave: number | null = null;

  /** Index of the escort being edited on the board (UI state, not serialized). */
  selectedEscort: number | null = null;

  constructor(public level: LevelDefinition) {}

  // ── Coordinate clamps (shared by board-path editing) ───────────────────────

  /** Snap a column to the nearest attack lane (escorts / detours are authored on
   *  attack lanes, matching the form selects). */
  private clampLane(col: number): number {
    const lanes = ATTACK_LANES as readonly number[];
    let best = lanes[0]!;
    let bestDist = Infinity;
    for (const c of lanes) {
      const d = Math.abs(c - col);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  /** Clamp a row to the board (0..ROWS-1), rounded to an integer. */
  private clampRow(row: number): number {
    return Math.max(0, Math.min(BOARD_ROWS - 1, Math.round(row)));
  }

  /** Subscribe to changes; returns an unsubscribe fn. */
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Notify subscribers after a caller mutated `level` directly (used by the
   *  level form, which edits many top-level fields inline + normalizes itself). */
  touch(): void {
    this.emit();
  }

  /** Replace the whole level (e.g. after import) and notify. */
  setLevel(level: LevelDefinition): void {
    this.level = level;
    this.selectedWave = null;
    this.selectedEscort = null;
    this.emit();
  }

  // ── crossWaypoints of the selected wave (board-path editing) ───────────────

  /** Append a detour waypoint to the selected wave (toCol snapped to an attack
   *  lane). No-op if no wave is selected. */
  addCrossWaypoint(col: number, row: number): void {
    const idx = this.selectedWave;
    if (idx === null || !this.waves[idx]) return;
    const wps = [...(this.waves[idx]!.crossWaypoints ?? []), { atRow: this.clampRow(row), toCol: this.clampLane(col) }];
    this.updateWave(idx, { crossWaypoints: wps });
  }

  /** Move the k-th detour waypoint of the selected wave. */
  updateCrossWaypoint(k: number, col: number, row: number): void {
    const idx = this.selectedWave;
    const entry = idx !== null ? this.waves[idx] : null;
    if (!entry?.crossWaypoints?.[k]) return;
    const wps = entry.crossWaypoints.map((wp, i) => (i === k ? { atRow: this.clampRow(row), toCol: this.clampLane(col) } : wp));
    this.updateWave(idx!, { crossWaypoints: wps });
  }

  /** Delete the k-th detour waypoint of the selected wave. */
  removeCrossWaypoint(k: number): void {
    const idx = this.selectedWave;
    const entry = idx !== null ? this.waves[idx] : null;
    if (!entry?.crossWaypoints?.[k]) return;
    this.updateWave(idx!, { crossWaypoints: entry.crossWaypoints.filter((_, i) => i !== k) });
  }

  // ── Escort start + path (board-path editing) ───────────────────────────────

  get escorts(): EscortSpec[] {
    return this.level.escorts ?? [];
  }

  /** Select an escort for board editing (or null to clear), then notify. */
  selectEscort(index: number | null): void {
    this.selectedEscort = index !== null && this.level.escorts?.[index] ? index : null;
    this.emit();
  }

  /** Move an escort's spawn point (col snapped to an attack lane). */
  setEscortStart(i: number, col: number, row: number): void {
    const esc = this.level.escorts?.[i];
    if (!esc) return;
    esc.startCol = this.clampLane(col);
    esc.startRow = this.clampRow(row);
    this.emit();
  }

  /** Append a path waypoint to escort `i`. Rows must stay strictly ascending
   *  (escort moves toward the enemy side) — returns false if the click row does
   *  not advance past the last point / spawn. */
  addEscortWaypoint(i: number, col: number, row: number): boolean {
    const esc = this.level.escorts?.[i];
    if (!esc) return false;
    const path = esc.path ?? [];
    const lastRow = path.length > 0 ? path[path.length - 1]!.row : esc.startRow;
    const r = this.clampRow(row);
    if (r <= lastRow) return false; // must advance toward the enemy side, keep strictly ascending
    path.push({ col: this.clampLane(col), row: r });
    esc.path = path;
    this.emit();
    return true;
  }

  /** Move the j-th path waypoint of escort `i`, clamping its row to the open
   *  interval between its neighbours so the strictly-ascending invariant holds. */
  updateEscortWaypoint(i: number, j: number, col: number, row: number): void {
    const esc = this.level.escorts?.[i];
    const path = esc?.path;
    if (!esc || !path?.[j]) return;
    const lo = (j > 0 ? path[j - 1]!.row : esc.startRow) + 1;
    const hi = (j < path.length - 1 ? path[j + 1]!.row : BOARD_ROWS) - 1;
    path[j]!.col = this.clampLane(col);
    if (lo <= hi) path[j]!.row = Math.max(lo, Math.min(hi, Math.round(row)));
    this.emit();
  }

  /** Delete the j-th path waypoint of escort `i`; drops an emptied path array. */
  removeEscortWaypoint(i: number, j: number): void {
    const esc = this.level.escorts?.[i];
    const path = esc?.path;
    if (!esc || !path || j < 0 || j >= path.length) return;
    path.splice(j, 1);
    if (path.length === 0) delete esc.path;
    this.emit();
  }

  // ── Wave entries ─────────────────────────────────────────────────────────────

  get waves(): WaveEntry[] {
    return this.level.waves.entries;
  }

  /** Select a wave entry by index (or null to clear), then notify. */
  selectWave(index: number | null): void {
    this.selectedWave = index;
    this.emit();
  }

  /** Append a new wave entry, select it, and notify. Returns its index. */
  addWave(entry: WaveEntry): number {
    this.waves.push(entry);
    this.selectedWave = this.waves.length - 1;
    this.emit();
    return this.selectedWave;
  }

  /** Patch fields of the wave entry at `index`, normalizing optional fields. */
  updateWave(index: number, patch: Partial<WaveEntry>): void {
    const entry = this.waves[index];
    if (!entry) return;
    Object.assign(entry, patch);
    // Normalize: drop default/empty optional fields so JSON stays clean.
    if (entry.spacingTicks === 0 || entry.spacingTicks === undefined) delete entry.spacingTicks;
    if (entry.isBoss === false || entry.isBoss === undefined) delete entry.isBoss;
    if (!entry.crossWaypoints || entry.crossWaypoints.length === 0) delete entry.crossWaypoints;
    this.emit();
  }

  /** Remove the wave entry at `index`, fixing up the selection, and notify. */
  removeWave(index: number): void {
    if (index < 0 || index >= this.waves.length) return;
    this.waves.splice(index, 1);
    if (this.selectedWave === index) this.selectedWave = null;
    else if (this.selectedWave !== null && this.selectedWave > index) this.selectedWave--;
    this.emit();
  }

  // ── Hazards ───────────────────────────────────────────────────────────────────

  get hazards(): HazardSpec[] {
    return this.level.hazards ?? [];
  }

  addHazard(spec: HazardSpec): void {
    if (!this.level.hazards) this.level.hazards = [];
    this.level.hazards.push(spec);
    this.emit();
  }

  updateHazard(index: number, patch: Partial<HazardSpec>): void {
    if (!this.level.hazards?.[index]) return;
    Object.assign(this.level.hazards[index], patch);
    const h = this.level.hazards[index]!;
    // Drop effect-specific params that no longer apply.
    if (h.effect !== 'speed') delete h.speedMult;
    if (h.effect !== 'fog') delete h.rangeMod;
    if (h.effect !== 'lava') delete h.dps;
    this.emit();
  }

  removeHazard(index: number): void {
    if (!this.level.hazards || index < 0 || index >= this.level.hazards.length) return;
    this.level.hazards.splice(index, 1);
    if (this.level.hazards.length === 0) delete this.level.hazards;
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
