import { BOARD_COLS, BOARD_ROWS } from './config';
import { Building } from './Building';
import { Unit } from './Unit';
import { Side, UnitState } from './types';

/**
 * Board manages spatial lookup for units and buildings.
 *
 * Two structures are maintained in parallel:
 * - `unitGrid`: fast O(1) lookup by (col, row) for combat range checks.
 * - `columnUnits`: per-column sorted list (by y_fp) for O(n_col) collision detection.
 *   n_col is typically < 15, so this is effectively O(1) in practice.
 */
export class Board {
  /** All active units keyed by id */
  readonly units: Map<number, Unit> = new Map();
  /** All active buildings keyed by id */
  readonly buildings: Map<number, Building> = new Map();

  /** unitGrid[row][col] = unit id, or null */
  private unitGrid: (number | null)[][] = [];
  /** buildingGrid[row][col] = building id, or null */
  private buildingGrid: (number | null)[][] = [];

  /**
   * Per-column unit lists, sorted by y_fp ascending.
   * Used for efficient collision detection in MovementSystem.
   */
  private columnUnits: Map<number, Unit[]> = new Map();

  constructor() {
    this.clearGrids();
  }

  private clearGrids(): void {
    this.unitGrid = Array.from({ length: BOARD_ROWS }, () =>
      new Array(BOARD_COLS).fill(null),
    );
    this.buildingGrid = Array.from({ length: BOARD_ROWS }, () =>
      new Array(BOARD_COLS).fill(null),
    );
  }

  // ─── Unit management ──────────────────────────────────────────────────────

  addUnit(unit: Unit): void {
    this.units.set(unit.id, unit);
    this.setUnitCell(unit.col, unit.row, unit.id);
    this.insertIntoColumn(unit);
  }

  removeUnit(unit: Unit): void {
    this.units.delete(unit.id);
    this.clearUnitCell(unit.col, unit.row);
    this.removeFromColumn(unit);
  }

  /** Call after a unit moves to keep grid and column list in sync. */
  updateUnitCell(unit: Unit, oldRow: number): void {
    const newRow = unit.row;
    if (newRow !== oldRow) {
      this.clearUnitCell(unit.col, oldRow);
      this.setUnitCell(unit.col, newRow, unit.id);
    }
    // Re-sort column list (insertion sort is cheap for small n)
    this.resortColumn(unit.col);
  }

  getUnitAt(col: number, row: number): Unit | null {
    const id = this.unitGrid[row]?.[col];
    return id != null ? (this.units.get(id) ?? null) : null;
  }

  isCellOccupiedByUnit(col: number, row: number): boolean {
    return this.unitGrid[row]?.[col] != null;
  }

  getFrontUnitInLane(col: number, side: Side): Unit | null {
    if (side === Side.Bottom) {
      for (let row = 0; row < BOARD_ROWS; row++) {
        const unit = this.getUnitAt(col, row);
        if (unit && unit.side === Side.Bottom) return unit;
      }
    } else {
      for (let row = BOARD_ROWS - 1; row >= 0; row--) {
        const unit = this.getUnitAt(col, row);
        if (unit && unit.side === Side.Top) return unit;
      }
    }
    return null;
  }

  /**
   * Returns the nearest living friendly unit directly ahead of `unit`
   * (in the direction of movement), or null if none.
   *
   * Used by MovementSystem for radius-based collision.
   * Searches the sorted column list — O(n_col).
   */
  getFriendlyUnitAhead(unit: Unit): Unit | null {
    const list = this.columnUnits.get(unit.col);
    if (!list || list.length <= 1) return null;

    const isBottom = unit.side === Side.Bottom;
    let bestUnit: Unit | null = null;
    let bestDist = Infinity;

    for (const other of list) {
      if (other.id === unit.id) continue;
      if (other.side !== unit.side) continue;
      if (other.isDead || other.state === UnitState.Dead) continue;

      if (isBottom) {
        // Bottom moves toward lower y — "ahead" = smaller y_fp
        if (other.y_fp < unit.y_fp) {
          const dist = unit.y_fp - other.y_fp;
          if (dist < bestDist) {
            bestDist = dist;
            bestUnit = other;
          }
        }
      } else {
        // Top moves toward higher y — "ahead" = larger y_fp
        if (other.y_fp > unit.y_fp) {
          const dist = other.y_fp - unit.y_fp;
          if (dist < bestDist) {
            bestDist = dist;
            bestUnit = other;
          }
        }
      }
    }

    return bestUnit;
  }

  // ─── Building management ──────────────────────────────────────────────────

  addBuilding(building: Building): void {
    this.buildings.set(building.id, building);
    this.buildingGrid[building.row][building.col] = building.id;
  }

  removeBuilding(building: Building): void {
    this.buildings.delete(building.id);
    this.buildingGrid[building.row][building.col] = null;
  }

  getBuildingAt(col: number, row: number): Building | null {
    const id = this.buildingGrid[row]?.[col];
    return id != null ? (this.buildings.get(id) ?? null) : null;
  }

  hasBuildingAt(col: number, row: number): boolean {
    return this.buildingGrid[row]?.[col] != null;
  }

  getUnitsInRange(col: number, row: number, range: number, side: Side): Unit[] {
    const result: Unit[] = [];
    for (let r = Math.max(0, row - range); r <= Math.min(BOARD_ROWS - 1, row + range); r++) {
      const unit = this.getUnitAt(col, r);
      if (unit && unit.side === side) result.push(unit);
    }
    return result;
  }

  // ─── Column list helpers ─────────────────────────────────────────────────

  private insertIntoColumn(unit: Unit): void {
    if (!this.columnUnits.has(unit.col)) {
      this.columnUnits.set(unit.col, []);
    }
    const list = this.columnUnits.get(unit.col)!;
    // Binary insert to maintain sorted order by y_fp ascending
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.y_fp < unit.y_fp) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, unit);
  }

  private removeFromColumn(unit: Unit): void {
    const list = this.columnUnits.get(unit.col);
    if (!list) return;
    const idx = list.indexOf(unit);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Re-sort the column list after a unit's y_fp changes.
   * Insertion sort is efficient for nearly-sorted lists (typical for in-lane movement).
   */
  private resortColumn(col: number): void {
    const list = this.columnUnits.get(col);
    if (!list || list.length <= 1) return;
    for (let i = 1; i < list.length; i++) {
      const unit = list[i]!;
      let j = i - 1;
      while (j >= 0 && list[j]!.y_fp > unit.y_fp) {
        list[j + 1] = list[j]!;
        j--;
      }
      list[j + 1] = unit;
    }
  }

  // ─── Private grid helpers ─────────────────────────────────────────────────

  private setUnitCell(col: number, row: number, id: number): void {
    if (row >= 0 && row < BOARD_ROWS) {
      this.unitGrid[row]![col] = id;
    }
  }

  private clearUnitCell(col: number, row: number): void {
    if (row >= 0 && row < BOARD_ROWS) {
      this.unitGrid[row]![col] = null;
    }
  }

  // ─── Debug ────────────────────────────────────────────────────────────────

  dump(): void {
    console.log(`Units: ${this.units.size}, Buildings: ${this.buildings.size}`);
  }
}
