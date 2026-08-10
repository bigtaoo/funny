// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 7/8).
// Pre-placed unit entries (garrison / attackerArmy, §16) + defender buildings —
// grouped together since garrison and attackerArmy share the exact same entry shape.
import { TOP_BUILDING_ROW } from '../../config';
import { BuildingType, UnitType } from '../../types';
import type { DefenderBuildingEntry, GarrisonEntry } from '../LevelDefinition';
import { ATTACK_LANE_SET, BUILDING_TYPE_SET, UNIT_TYPE_SET, fail, int, isObject, str } from './helpers';

/**
 * Parse one {@link GarrisonEntry} — shared by garrison (defender / Top) and
 * attackerArmy (attacker / Bottom); both pre-place units in attack lanes within
 * the combat zone (rows 1..16) with optional `initialHp` (troops = HP, §16.1).
 */
function parseGarrisonEntry(e: unknown, ep: string): GarrisonEntry {
  if (!isObject(e)) fail(ep, 'expected a garrison entry object');
  const unitType = str(e.unitType, `${ep}.unitType`);
  if (!UNIT_TYPE_SET.has(unitType)) {
    fail(`${ep}.unitType`, `unknown unit type '${unitType}' (expected one of ${[...UNIT_TYPE_SET].join(', ')})`);
  }
  const col = int(e.col, `${ep}.col`);
  if (!ATTACK_LANE_SET.has(col)) fail(`${ep}.col`, `lane ${col} is not an attack lane`);
  const row = int(e.row, `${ep}.row`);
  if (row < 1 || row > TOP_BUILDING_ROW - 1) {
    fail(`${ep}.row`, `garrison row must be 1..${TOP_BUILDING_ROW - 1} (combat zone + spawn rows), got ${row}`);
  }
  const entry: GarrisonEntry = { unitType: unitType as UnitType, col, row };
  if (e.initialHp !== undefined) {
    const hp = int(e.initialHp, `${ep}.initialHp`);
    if (hp <= 0) fail(`${ep}.initialHp`, `must be > 0, got ${hp}`);
    entry.initialHp = hp;
  }
  return entry;
}

export function parseGarrison(v: unknown, path: string): GarrisonEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of garrison entries');
  if (v.length === 0) return [];
  return v.map((e, i) => parseGarrisonEntry(e, `${path}[${i}]`));
}

export function parseAttackerArmy(v: unknown, path: string): GarrisonEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of attacker army entries');
  if (v.length === 0) return [];
  return v.map((e, i) => parseGarrisonEntry(e, `${path}[${i}]`));
}

export function parseDefenderBuildings(v: unknown, path: string): DefenderBuildingEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of defender building entries');
  if (v.length === 0) return [];
  return v.map((e, i) => {
    const ep = `${path}[${i}]`;
    if (!isObject(e)) fail(ep, 'expected a defender building entry object');
    const buildingType = str(e.buildingType, `${ep}.buildingType`);
    if (!BUILDING_TYPE_SET.has(buildingType)) {
      fail(`${ep}.buildingType`, `unknown building type '${buildingType}' (expected one of ${[...BUILDING_TYPE_SET].join(', ')})`);
    }
    const col = int(e.col, `${ep}.col`);
    if (!ATTACK_LANE_SET.has(col)) fail(`${ep}.col`, `lane ${col} is not an attack lane (base cols 5–6 are not valid)`);
    return { buildingType: buildingType as BuildingType, col };
  });
}
