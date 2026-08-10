// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 1/8).
// The primitive scalar validators + shared lookup sets every parse*.ts sibling
// imports — zero shared mutable state, just narrowing functions and constants.
import { ATTACK_LANES, BASE_UPGRADE_COSTS } from '../../config';
import { BuildingType, UnitType } from '../../types';

/** Thrown when a level JSON fails validation. `path` locates the bad field. */
export class LevelParseError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'LevelParseError';
  }
}

export const ATTACK_LANE_SET: ReadonlySet<number> = new Set<number>(ATTACK_LANES as readonly number[]);
export const UNIT_TYPE_SET: ReadonlySet<string> = new Set<string>(Object.values(UnitType));
export const BUILDING_TYPE_SET: ReadonlySet<string> = new Set<string>(Object.values(BuildingType));
export const MAX_BASE_LEVEL = BASE_UPGRADE_COSTS.length;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fail(path: string, message: string): never {
  throw new LevelParseError(path, message);
}

export function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a finite number, got ${typeof v}`);
  return v as number;
}

export function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

export function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${typeof v}`);
  return v as string;
}

export function optBool(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(path, `expected a boolean, got ${typeof v}`);
  return v;
}

export function optStringArray(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, `expected an array of strings`);
  return v.map((e, i) => str(e, `${path}[${i}]`));
}
