// Split from AISystem.ts (2026-08-10, independent function module range 6, part 4/5).
// 2×2 footprint scan for the best meteor anchor + the public-cost estimate that
// gates offensive nukes by ink-value — both pure functions of GameState/config.
import { BOARD_COLS, BOARD_ROWS, CARD_DEFINITIONS } from '../../config';
import { GameState } from '../../GameState';
import { Side, UnitType } from '../../types';

/**
 * Find the best 2×2 anchor for a meteor over enemy (Bottom) units.
 * Returns the top-left cell of the footprint, or null if no cluster reaches
 * `minCount` — or, when `minCostForValue > 0` ({@link DifficultyParams.useValueTrades}),
 * if the enemies' own card cost (public knowledge: every unit type has a known
 * ink cost) doesn't clear that many times the spell's own cost. That keeps the
 * AI from nuking a lone 3-ink Runner with a 12-ink Meteor.
 * With `preferNearBase`, ties favour the footprint closest to the AI base
 * (highest row) so defensive nukes land on the most urgent threat.
 */
export function findMeteorTarget(
  state: GameState,
  minCount: number,
  preferNearBase: boolean,
  minCostForValue: number,
): { col: number; row: number } | null {
  // Count enemy units (and index by cell for footprint scans) per integer cell.
  const cell: Map<number, number> = new Map();
  const unitsByCell: Map<number, UnitType[]> = new Map();
  for (const unit of state.board.units.values()) {
    if (unit.side !== Side.Bottom || unit.isDead) continue;
    const key = unit.row * BOARD_COLS + unit.col;
    cell.set(key, (cell.get(key) ?? 0) + 1);
    const list = unitsByCell.get(key);
    if (list) list.push(unit.unitType); else unitsByCell.set(key, [unit.unitType]);
  }
  if (cell.size === 0) return null;

  let best: { col: number; row: number } | null = null;
  let bestCount = minCount - 1;
  let bestRow = -1;
  const at = (c: number, r: number) =>
    (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) ? 0 : (cell.get(r * BOARD_COLS + c) ?? 0);
  const unitsAt = (c: number, r: number): UnitType[] =>
    (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) ? [] : (unitsByCell.get(r * BOARD_COLS + c) ?? []);

  // Anchor scan: footprint covers cols [c, c+1], rows [r, r+1].
  for (let r = 0; r <= BOARD_ROWS - 2; r++) {
    for (let c = 0; c <= BOARD_COLS - 2; c++) {
      const count = at(c, r) + at(c + 1, r) + at(c, r + 1) + at(c + 1, r + 1);
      if (count < minCount) continue;
      if (minCostForValue > 0) {
        const units = [...unitsAt(c, r), ...unitsAt(c + 1, r), ...unitsAt(c, r + 1), ...unitsAt(c + 1, r + 1)];
        const totalCost = units.reduce((sum, t) => sum + estimateUnitCost(t), 0);
        if (totalCost < minCostForValue * 1.3) continue;
      }
      if (count > bestCount || (count === bestCount && preferNearBase && r > bestRow)) {
        bestCount = count;
        bestRow = r;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

/** Public knowledge: the ink cost of the cheapest pool card that spawns `type` (0 if none). */
export function estimateUnitCost(type: UnitType): number {
  let min = Infinity;
  for (const c of CARD_DEFINITIONS) {
    if (c.unitType === type && c.cost < min) min = c.cost;
  }
  return Number.isFinite(min) ? min : 0;
}
