import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS } from '../config';
import { UnitType } from '../types';
import type {
  Cell,
  HazardSpec,
  LevelDefinition,
  LevelRewards,
  ObjectiveSpec,
  WaveEntry,
  WaveScript,
} from './LevelDefinition';

/**
 * Runtime validator for campaign levels loaded from JSON.
 *
 * Campaign levels live as JSON (single source of truth, authored by the level
 * editor — see `tools/level-editor/DESIGN.md`) and are bundled at build time.
 * JSON gives no compile-time type safety, so {@link parseLevelDefinition} is the
 * sole guard: it narrows raw `unknown` to a {@link LevelDefinition}, rejecting
 * malformed data with a field-path error that pinpoints the offending key.
 *
 * Validation is intentionally strict about anything the engine consumes
 * (objective kind, unit types, lanes, cell bounds) and lenient/pass-through for
 * reserved-but-unconsumed fields (hazards, crossWaypoints, story keys), which
 * are preserved verbatim so editing a level never silently drops future data.
 */

/** Thrown when a level JSON fails validation. `path` locates the bad field. */
export class LevelParseError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'LevelParseError';
  }
}

const ATTACK_LANE_SET: ReadonlySet<number> = new Set<number>(ATTACK_LANES as readonly number[]);
const UNIT_TYPE_SET: ReadonlySet<string> = new Set<string>(Object.values(UnitType));

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new LevelParseError(path, message);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a finite number, got ${typeof v}`);
  return v as number;
}

function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${typeof v}`);
  return v as string;
}

function optBool(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(path, `expected a boolean, got ${typeof v}`);
  return v;
}

function optStringArray(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, `expected an array of strings`);
  return v.map((e, i) => str(e, `${path}[${i}]`));
}

function parseObjective(v: unknown, path: string): ObjectiveSpec {
  if (!isObject(v)) fail(path, 'expected an objective object');
  const kind = str(v.kind, `${path}.kind`);
  if (kind === 'survive') return { kind: 'survive' };
  if (kind === 'timed_defense') {
    const durationTicks = int(v.durationTicks, `${path}.durationTicks`);
    if (durationTicks <= 0) fail(`${path}.durationTicks`, `must be > 0, got ${durationTicks}`);
    return { kind: 'timed_defense', durationTicks };
  }
  return fail(`${path}.kind`, `unknown objective kind '${kind}' (expected 'survive' | 'timed_defense')`);
}

function parseCell(v: unknown, path: string): Cell {
  if (!isObject(v)) fail(path, 'expected a {col,row} cell');
  const col = int(v.col, `${path}.col`);
  const row = int(v.row, `${path}.row`);
  if (col < 0 || col >= BOARD_COLS) fail(`${path}.col`, `out of bounds 0..${BOARD_COLS - 1}, got ${col}`);
  if (row < 0 || row >= BOARD_ROWS) fail(`${path}.row`, `out of bounds 0..${BOARD_ROWS - 1}, got ${row}`);
  return { col, row };
}

function parseWaveEntry(v: unknown, path: string): WaveEntry {
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

function parseWaves(v: unknown, path: string): WaveScript {
  if (!isObject(v)) fail(path, 'expected a waves object');
  if (!Array.isArray(v.entries)) fail(`${path}.entries`, 'expected an array of wave entries');
  if (v.entries.length === 0) fail(`${path}.entries`, 'a level must have at least one wave entry');
  return { entries: v.entries.map((e, i) => parseWaveEntry(e, `${path}.entries[${i}]`)) };
}

function parseBoard(v: unknown, path: string): LevelDefinition['board'] {
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

function parseHazards(v: unknown, path: string): HazardSpec[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of hazards');
  const effects = new Set(['speed', 'fog', 'lava']);
  return v.map((h, i) => {
    const hp = `${path}[${i}]`;
    if (!isObject(h)) fail(hp, 'expected a hazard object');
    const col = int(h.col, `${hp}.col`);
    if (!Array.isArray(h.rowRange) || h.rowRange.length !== 2) {
      fail(`${hp}.rowRange`, 'expected a [from,to] tuple');
    }
    const effect = str(h.effect, `${hp}.effect`);
    if (!effects.has(effect)) fail(`${hp}.effect`, `unknown hazard effect '${effect}'`);
    return {
      col,
      rowRange: [int(h.rowRange[0], `${hp}.rowRange[0]`), int(h.rowRange[1], `${hp}.rowRange[1]`)],
      effect: effect as HazardSpec['effect'],
    };
  });
}

function parseRewards(v: unknown, path: string): LevelRewards | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'expected a rewards object');
  const rewards: LevelRewards = {};
  if (v.coins !== undefined) rewards.coins = int(v.coins, `${path}.coins`);
  if (v.unlockSkinId !== undefined) rewards.unlockSkinId = str(v.unlockSkinId, `${path}.unlockSkinId`);
  if (v.unlockStoryKey !== undefined) {
    rewards.unlockStoryKey = str(v.unlockStoryKey, `${path}.unlockStoryKey`) as LevelRewards['unlockStoryKey'];
  }
  if (v.starThresholds !== undefined) {
    const st = v.starThresholds;
    if (!Array.isArray(st) || st.length !== 3) fail(`${path}.starThresholds`, 'expected a [s1,s2,s3] tuple');
    const t = st.map((x, i) => {
      const n = int(x, `${path}.starThresholds[${i}]`);
      if (n < 0 || n > 100) fail(`${path}.starThresholds[${i}]`, `HP% must be 0..100, got ${n}`);
      return n;
    }) as [number, number, number];
    if (!(t[0] <= t[1] && t[1] <= t[2])) {
      fail(`${path}.starThresholds`, `must be non-decreasing (1★ ≤ 2★ ≤ 3★), got [${t.join(', ')}]`);
    }
    rewards.starThresholds = t;
  }
  return rewards;
}

/**
 * Validate and narrow a raw (JSON-parsed) value into a {@link LevelDefinition}.
 * Throws {@link LevelParseError} with a field path on the first violation.
 */
export function parseLevelDefinition(raw: unknown, ctx = 'level'): LevelDefinition {
  if (!isObject(raw)) fail(ctx, 'expected a level object');

  const level: LevelDefinition = {
    id: str(raw.id, `${ctx}.id`),
    chapter: int(raw.chapter, `${ctx}.chapter`),
    seed: num(raw.seed, `${ctx}.seed`),
    objective: parseObjective(raw.objective, `${ctx}.objective`),
    waves: parseWaves(raw.waves, `${ctx}.waves`),
  };
  if (level.id.length === 0) fail(`${ctx}.id`, 'must be a non-empty id');

  const board = parseBoard(raw.board, `${ctx}.board`);
  if (board) level.board = board;

  const hazards = parseHazards(raw.hazards, `${ctx}.hazards`);
  if (hazards) level.hazards = hazards;

  if (raw.startCoins !== undefined) {
    const startCoins = int(raw.startCoins, `${ctx}.startCoins`);
    if (startCoins < 0) fail(`${ctx}.startCoins`, `must be >= 0, got ${startCoins}`);
    level.startCoins = startCoins;
  }
  if (raw.coinRegenMult !== undefined) {
    const m = num(raw.coinRegenMult, `${ctx}.coinRegenMult`);
    if (m < 0) fail(`${ctx}.coinRegenMult`, `must be >= 0, got ${m}`);
    level.coinRegenMult = m;
  }

  const loadout = optStringArray(raw.loadout, `${ctx}.loadout`);
  if (loadout) level.loadout = loadout;
  const bannedCards = optStringArray(raw.bannedCards, `${ctx}.bannedCards`);
  if (bannedCards) level.bannedCards = bannedCards;

  const rewards = parseRewards(raw.rewards, `${ctx}.rewards`);
  if (rewards) level.rewards = rewards;

  if (raw.story !== undefined) {
    if (!isObject(raw.story)) fail(`${ctx}.story`, 'expected a story object');
    const story: NonNullable<LevelDefinition['story']> = {};
    if (raw.story.introKey !== undefined) {
      story.introKey = str(raw.story.introKey, `${ctx}.story.introKey`) as NonNullable<LevelDefinition['story']>['introKey'];
    }
    if (raw.story.outroKey !== undefined) {
      story.outroKey = str(raw.story.outroKey, `${ctx}.story.outroKey`) as NonNullable<LevelDefinition['story']>['outroKey'];
    }
    level.story = story;
  }

  return level;
}
