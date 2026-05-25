import { BOARD_COLS, BOARD_ROWS } from './config';
import { Building } from './Building';
import { Unit } from './Unit';
import { Side } from './types';

/**
 * Board manages the spatial lookup structures for units and buildings.
 * Game logic systems read from Board to find neighbors and targets.
 */
export class Board {
  /** All active units keyed by id */
  readonly units: Map<number, Unit> = new Map();
  /** All active buildings keyed by id */
  readonly buildings: Map<number, Building> = new Map();

  /**
   * Fast lookup: unitsByCell[row][col] = unit id or null.
   * Transit rows (0 and 18) allow stacking so we use a Set there.
   */
  private unitGrid: (number | null)[][] = [];
  private buildingGrid: (number | null)[][] = [];

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
    this.setUnitCell(unit.col, Math.round(unit.row), unit.id);
  }

  removeUnit(unit: Unit): void {
    this.units.delete(unit.id);
    this.clearUnitCell(unit.col, Math.round(unit.row));
  }

  /** Call after a unit moves to update grid lookup */
  updateUnitCell(unit: Unit, oldRow: number): void {
    const newRow = Math.round(unit.row);
    if (newRow !== oldRow) {
      this.clearUnitCell(unit.col, oldRow);
      this.setUnitCell(unit.col, newRow, unit.id);
    }
  }

  getUnitAt(col: number, row: number): Unit | null {
    const id = this.unitGrid[row]?.[col];
    return id != null ? (this.units.get(id) ?? null) : null;
  }

  isCellOccupiedByUnit(col: number, row: number): boolean {
    return this.unitGrid[row]?.[col] != null;
  }

  /** Returns first unit in the given column moving toward the enemy from startRow */
  getFrontUnitInLane(col: number, side: Side): Unit | null {
    // Bottom player moves up (decreasing row), top player moves down (increasing row)
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

  /** Returns all units within Manhattan range in the same column */
  getUnitsInRange(col: number, row: number, range: number, side: Side): Unit[] {
    const result: Unit[] = [];
    for (let r = Math.max(0, row - range); r <= Math.min(BOARD_ROWS - 1, row + range); r++) {
      const unit = this.getUnitAt(col, r);
      if (unit && unit.side === side) result.push(unit);
    }
    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private setUnitCell(col: number, row: number, id: number): void {
    if (row >= 0 && row < BOARD_ROWS) {
      this.unitGrid[row][col] = id;
    }
  }

  private clearUnitCell(col: number, row: number): void {
    if (row >= 0 && row < BOARD_ROWS) {
      this.unitGrid[row][col] = null;
    }
  }

  // ─── Debug ────────────────────────────────────────────────────────────────

  dump(): void {
    console.log(`Units: ${this.units.size}, Buildings: ${this.buildings.size}`);
  }
}
