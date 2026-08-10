// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 3/8).
// Cell bounds-checking + the scripted-wave entry/list parsers.
import { BOARD_COLS, BOARD_ROWS } from '../../config';
import { UnitType } from '../../types';
import type { Cell, WaveEntry, WaveScript } from '../LevelDefinition';
import { ATTACK_LANE_SET, UNIT_TYPE_SET, fail, int, isObject, optBool, str } from './helpers';

export function parseCell(v: unknown, path: string): Cell {
  if (!isObject(v)) fail(path, 'expected a {col,row} cell');
  const col = int(v.col, `${path}.col`);
  const row = int(v.row, `${path}.row`);
  if (col < 0 || col >= BOARD_COLS) fail(`${path}.col`, `out of bounds 0..${BOARD_COLS - 1}, got ${col}`);
  if (row < 0 || row >= BOARD_ROWS) fail(`${path}.row`, `out of bounds 0..${BOARD_ROWS - 1}, got ${row}`);
  return { col, row };
}

export function parseWaveEntry(v: unknown, path: string): WaveEntry {
  if (!isObject(v)) fail(path, 'expected a wave entry object');
  const atTick = int(v.atTick, `${path}.atTick`);
  if (atTick < 0) fail(`${path}.atTick`, `must be >= 0, got ${atTick}`);

  const unitType = str(v.unitType, `${path}.unitType`);
  if (!UNIT_TYPE_SET.has(unitType)) {
    fail(`${path}.unitType`, `unknown unit type '${unitType}' (expected one of ${[...UNIT_TYPE_SET].join(', ')})`);
  }

  const col = int(v.col, `${path}.col`);
  if (!ATTACK_LANE_SET.has(col)) {
    fail(`${path}.col`, `lane ${col} is not an attack lane (expected one of ${[...ATTACK_LANE_SET].join(', ')})`);
  }

  const count = int(v.count, `${path}.count`);
  if (count <= 0) fail(`${path}.count`, `must be > 0, got ${count}`);

  const entry: WaveEntry = { atTick, unitType: unitType as UnitType, col, count };

  if (v.spacingTicks !== undefined) {
    const spacingTicks = int(v.spacingTicks, `${path}.spacingTicks`);
    if (spacingTicks < 0) fail(`${path}.spacingTicks`, `must be >= 0, got ${spacingTicks}`);
    entry.spacingTicks = spacingTicks;
  }

  // crossWaypoints / isBoss are reserved (not consumed in P0). Validate shape
  // lightly and preserve verbatim so the editor never drops future data.
  if (v.crossWaypoints !== undefined) {
    if (!Array.isArray(v.crossWaypoints)) fail(`${path}.crossWaypoints`, 'expected an array');
    entry.crossWaypoints = v.crossWaypoints.map((w, i) => {
      const wp = w as Record<string, unknown>;
      const cpath = `${path}.crossWaypoints[${i}]`;
      if (!isObject(wp)) fail(cpath, 'expected a {atRow,toCol} waypoint');
      return { atRow: int(wp.atRow, `${cpath}.atRow`), toCol: int(wp.toCol, `${cpath}.toCol`) };
    });
  }

  const isBoss = optBool(v.isBoss, `${path}.isBoss`);
  if (isBoss !== undefined) entry.isBoss = isBoss;

  return entry;
}

export function parseWaves(v: unknown, path: string, allowEmpty: boolean): WaveScript {
  if (!isObject(v)) fail(path, 'expected a waves object');
  if (!Array.isArray(v.entries)) fail(`${path}.entries`, 'expected an array of wave entries');
  // SLG siege battles (G3, §16) are pure pre-placed (attackerArmy + garrison), no scripted
  // waves — so an empty entries[] is valid there. Campaign levels still require ≥1 wave.
  if (v.entries.length === 0 && !allowEmpty) {
    fail(`${path}.entries`, 'a level must have at least one wave entry');
  }
  return { entries: v.entries.map((e, i) => parseWaveEntry(e, `${path}.entries[${i}]`)) };
}
