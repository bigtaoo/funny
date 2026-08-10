// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 4/8).
// The optional per-level board override (active lanes / per-lane spawn depth / cell mask).
import { BOARD_ROWS } from '../../config';
import type { LevelDefinition } from '../LevelDefinition';
import { ATTACK_LANE_SET, fail, int, isObject } from './helpers';
import { parseCell } from './waves';

export function parseBoard(v: unknown, path: string): LevelDefinition['board'] {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'expected a board object');
  const board: NonNullable<LevelDefinition['board']> = {};

  if (v.activeLanes !== undefined) {
    if (!Array.isArray(v.activeLanes)) fail(`${path}.activeLanes`, 'expected an array of lane columns');
    board.activeLanes = v.activeLanes.map((c, i) => {
      const col = int(c, `${path}.activeLanes[${i}]`);
      if (!ATTACK_LANE_SET.has(col)) fail(`${path}.activeLanes[${i}]`, `lane ${col} is not an attack lane`);
      return col;
    });
  }

  if (v.laneLength !== undefined) {
    if (!isObject(v.laneLength)) fail(`${path}.laneLength`, 'expected a col→length object');
    const ll: Record<string, number> = {};
    for (const [colStr, lenVal] of Object.entries(v.laneLength as Record<string, unknown>)) {
      const col = parseInt(colStr, 10);
      if (isNaN(col) || !ATTACK_LANE_SET.has(col)) {
        fail(`${path}.laneLength`, `key '${colStr}' is not a valid attack lane column`);
      }
      const len = int(lenVal, `${path}.laneLength.${colStr}`);
      const spawnRow = BOARD_ROWS - len;
      if (spawnRow < 2 || spawnRow > 16) {
        fail(`${path}.laneLength.${colStr}`, `laneLength ${len} puts spawnRow at ${spawnRow}, must give spawnRow 2..16`);
      }
      ll[colStr] = len;
    }
    board.laneLength = ll;
  }

  if (v.cellMask !== undefined) {
    if (!isObject(v.cellMask)) fail(`${path}.cellMask`, 'expected a cellMask object');
    const mask: NonNullable<NonNullable<LevelDefinition['board']>['cellMask']> = {};
    if (v.cellMask.blocked !== undefined) {
      if (!Array.isArray(v.cellMask.blocked)) fail(`${path}.cellMask.blocked`, 'expected an array of cells');
      mask.blocked = v.cellMask.blocked.map((c, i) => parseCell(c, `${path}.cellMask.blocked[${i}]`));
    }
    if (v.cellMask.noBuild !== undefined) {
      if (!Array.isArray(v.cellMask.noBuild)) fail(`${path}.cellMask.noBuild`, 'expected an array of cells');
      mask.noBuild = v.cellMask.noBuild.map((c, i) => parseCell(c, `${path}.cellMask.noBuild[${i}]`));
    }
    board.cellMask = mask;
  }

  return board;
}
