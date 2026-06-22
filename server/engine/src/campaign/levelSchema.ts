import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS, TOP_BUILDING_ROW, BOTTOM_BUILDING_ROW, BASE_UPGRADE_COSTS } from '../config';
import { BuildingType, UnitType } from '../types';
import type {
  Cell,
  DefenderBuildingEntry,
  EscortSpec,
  GarrisonEntry,
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
const BUILDING_TYPE_SET: ReadonlySet<string> = new Set<string>(Object.values(BuildingType));
const MAX_BASE_LEVEL = BASE_UPGRADE_COSTS.length;

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
  if (kind === 'destroy_base') {
    const spec: Extract<ObjectiveSpec, { kind: 'destroy_base' }> = { kind: 'destroy_base' };
    if (v.durationTicks !== undefined) {
      const durationTicks = int(v.durationTicks, `${path}.durationTicks`);
      if (durationTicks <= 0) fail(`${path}.durationTicks`, `must be > 0, got ${durationTicks}`);
      spec.durationTicks = durationTicks;
    }
    return spec;
  }
  if (kind === 'boss') return { kind: 'boss' };
  if (kind === 'timed_defense') {
    const durationTicks = int(v.durationTicks, `${path}.durationTicks`);
    if (durationTicks <= 0) fail(`${path}.durationTicks`, `must be > 0, got ${durationTicks}`);
    return { kind: 'timed_defense', durationTicks };
  }
  if (kind === 'leak_limit') {
    const maxLeaks = int(v.maxLeaks, `${path}.maxLeaks`);
    if (maxLeaks < 0) fail(`${path}.maxLeaks`, `must be >= 0, got ${maxLeaks}`);
    return { kind: 'leak_limit', maxLeaks };
  }
  if (kind === 'escort') {
    const req = v.required;
    if (req === 'all' || req === 'any') return { kind: 'escort', required: req };
    const n = int(req, `${path}.required`);
    if (n < 1) fail(`${path}.required`, `numeric required must be >= 1, got ${n}`);
    return { kind: 'escort', required: n };
  }
  return fail(`${path}.kind`, `unknown objective kind '${kind}' (expected 'survive' | 'timed_defense' | 'destroy_base' | 'leak_limit' | 'boss' | 'escort')`);
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

function parseWaves(v: unknown, path: string, allowEmpty: boolean): WaveScript {
  if (!isObject(v)) fail(path, 'expected a waves object');
  if (!Array.isArray(v.entries)) fail(`${path}.entries`, 'expected an array of wave entries');
  // SLG siege battles (G3, §16) are pure pre-placed (attackerArmy + garrison), no scripted
  // waves — so an empty entries[] is valid there. Campaign levels still require ≥1 wave.
  if (v.entries.length === 0 && !allowEmpty) {
    fail(`${path}.entries`, 'a level must have at least one wave entry');
  }
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
    const spec: HazardSpec = {
      col,
      rowRange: [int(h.rowRange[0], `${hp}.rowRange[0]`), int(h.rowRange[1], `${hp}.rowRange[1]`)],
      effect: effect as HazardSpec['effect'],
    };
    if (h.speedMult !== undefined) spec.speedMult = num(h.speedMult, `${hp}.speedMult`);
    if (h.rangeMod  !== undefined) spec.rangeMod  = num(h.rangeMod,  `${hp}.rangeMod`);
    if (h.dps       !== undefined) spec.dps       = num(h.dps,       `${hp}.dps`);
    return spec;
  });
}

function parseEscorts(v: unknown, path: string): EscortSpec[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of escort specs');
  if (v.length === 0) return [];
  return v.map((e, i) => {
    const ep = `${path}[${i}]`;
    if (!isObject(e)) fail(ep, 'expected an escort spec object');
    const id = str(e.id, `${ep}.id`);
    if (id.length === 0) fail(`${ep}.id`, 'must be a non-empty string');
    const hp    = num(e.hp,    `${ep}.hp`);
    if (hp <= 0) fail(`${ep}.hp`, `must be > 0, got ${hp}`);
    const speed = num(e.speed, `${ep}.speed`);
    if (speed <= 0) fail(`${ep}.speed`, `must be > 0, got ${speed}`);
    const startCol = int(e.startCol, `${ep}.startCol`);
    if (startCol < 0 || startCol >= BOARD_COLS) {
      fail(`${ep}.startCol`, `out of bounds 0..${BOARD_COLS - 1}, got ${startCol}`);
    }
    const startRow = int(e.startRow, `${ep}.startRow`);
    if (startRow < 0 || startRow >= BOARD_ROWS) {
      fail(`${ep}.startRow`, `out of bounds 0..${BOARD_ROWS - 1}, got ${startRow}`);
    }
    const spec: EscortSpec = { id, hp, speed, startCol, startRow };
    if (e.path !== undefined) {
      if (!Array.isArray(e.path)) fail(`${ep}.path`, 'expected an array of waypoints');
      spec.path = (e.path as unknown[]).map((w, j) => {
        const wp = `${ep}.path[${j}]`;
        if (!isObject(w)) fail(wp, 'expected a {col, row} waypoint');
        const wCol = int(w.col, `${wp}.col`);
        const wRow = int(w.row, `${wp}.row`);
        if (wCol < 0 || wCol >= BOARD_COLS) fail(`${wp}.col`, `out of bounds 0..${BOARD_COLS - 1}, got ${wCol}`);
        if (wRow < 0 || wRow >= BOARD_ROWS) fail(`${wp}.row`, `out of bounds 0..${BOARD_ROWS - 1}, got ${wRow}`);
        return { col: wCol, row: wRow };
      });
      // Waypoints must be strictly ascending in row (escort moves toward higher rows).
      for (let j = 1; j < spec.path!.length; j++) {
        if (spec.path![j]!.row <= spec.path![j - 1]!.row) {
          fail(`${ep}.path[${j}].row`, 'waypoint rows must be strictly ascending');
        }
      }
    }
    return spec;
  });
}

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

function parseGarrison(v: unknown, path: string): GarrisonEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of garrison entries');
  if (v.length === 0) return [];
  return v.map((e, i) => parseGarrisonEntry(e, `${path}[${i}]`));
}

function parseAttackerArmy(v: unknown, path: string): GarrisonEntry[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of attacker army entries');
  if (v.length === 0) return [];
  return v.map((e, i) => parseGarrisonEntry(e, `${path}[${i}]`));
}

function parseDefenderBuildings(v: unknown, path: string): DefenderBuildingEntry[] | undefined {
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
  if (v.materials !== undefined) {
    if (!isObject(v.materials)) fail(`${path}.materials`, 'expected a material→amount object');
    const mats: Record<string, number> = {};
    for (const [k, amt] of Object.entries(v.materials)) {
      const n = int(amt, `${path}.materials.${k}`);
      if (n < 0) fail(`${path}.materials.${k}`, `must be >= 0, got ${n}`);
      mats[k] = n;
    }
    rewards.materials = mats;
  }
  return rewards;
}

/**
 * Validate and narrow a raw (JSON-parsed) value into a {@link LevelDefinition}.
 * Throws {@link LevelParseError} with a field path on the first violation.
 */
export function parseLevelDefinition(raw: unknown, ctx = 'level'): LevelDefinition {
  if (!isObject(raw)) fail(ctx, 'expected a level object');

  // A siege battle (pre-placed attacker army / hard time limit, §16) carries no scripted
  // waves; everywhere else ≥1 wave entry is still required.
  const isSiegeBattle = raw.attackerArmy !== undefined || raw.battleTimeoutTicks !== undefined;

  const level: LevelDefinition = {
    id: str(raw.id, `${ctx}.id`),
    chapter: int(raw.chapter, `${ctx}.chapter`),
    seed: num(raw.seed, `${ctx}.seed`),
    objective: parseObjective(raw.objective, `${ctx}.objective`),
    waves: parseWaves(raw.waves, `${ctx}.waves`, isSiegeBattle),
  };
  if (level.id.length === 0) fail(`${ctx}.id`, 'must be a non-empty id');

  const board = parseBoard(raw.board, `${ctx}.board`);
  if (board) level.board = board;

  const hazards = parseHazards(raw.hazards, `${ctx}.hazards`);
  if (hazards) level.hazards = hazards;

  if (raw.startInk !== undefined) {
    const startInk = int(raw.startInk, `${ctx}.startInk`);
    if (startInk < 0) fail(`${ctx}.startInk`, `must be >= 0, got ${startInk}`);
    level.startInk = startInk;
  }
  if (raw.inkRegenMult !== undefined) {
    const m = num(raw.inkRegenMult, `${ctx}.inkRegenMult`);
    if (m < 0) fail(`${ctx}.inkRegenMult`, `must be >= 0, got ${m}`);
    level.inkRegenMult = m;
  }

  const loadout = optStringArray(raw.loadout, `${ctx}.loadout`);
  if (loadout) level.loadout = loadout;
  const bannedCards = optStringArray(raw.bannedCards, `${ctx}.bannedCards`);
  if (bannedCards) level.bannedCards = bannedCards;

  if (raw.levelSpells !== undefined) {
    if (!Array.isArray(raw.levelSpells)) fail(`${ctx}.levelSpells`, 'expected an array');
    level.levelSpells = (raw.levelSpells as unknown[]).map((s, i) => {
      const sp = `${ctx}.levelSpells[${i}]`;
      if (!isObject(s)) fail(sp, 'expected a {cardId, initialCount} object');
      const cardId      = str(s.cardId,      `${sp}.cardId`);
      const initialCount = int(s.initialCount, `${sp}.initialCount`);
      if (initialCount < 0) fail(`${sp}.initialCount`, 'must be >= 0');
      return { cardId, initialCount };
    });
  }

  const escorts = parseEscorts(raw.escorts, `${ctx}.escorts`);
  if (escorts && escorts.length > 0) level.escorts = escorts;

  const garrison = parseGarrison(raw.garrison, `${ctx}.garrison`);
  if (garrison && garrison.length > 0) level.garrison = garrison;

  const attackerArmy = parseAttackerArmy(raw.attackerArmy, `${ctx}.attackerArmy`);
  if (attackerArmy && attackerArmy.length > 0) level.attackerArmy = attackerArmy;

  if (raw.battleTimeoutTicks !== undefined) {
    const t = int(raw.battleTimeoutTicks, `${ctx}.battleTimeoutTicks`);
    if (t <= 0) fail(`${ctx}.battleTimeoutTicks`, `must be > 0, got ${t}`);
    level.battleTimeoutTicks = t;
  }

  const defenderBuildings = parseDefenderBuildings(raw.defenderBuildings, `${ctx}.defenderBuildings`);
  if (defenderBuildings && defenderBuildings.length > 0) level.defenderBuildings = defenderBuildings;

  if (raw.defenderBaseLevel !== undefined) {
    const lvl = int(raw.defenderBaseLevel, `${ctx}.defenderBaseLevel`);
    if (lvl < 0 || lvl > MAX_BASE_LEVEL) {
      fail(`${ctx}.defenderBaseLevel`, `must be 0..${MAX_BASE_LEVEL}, got ${lvl}`);
    }
    level.defenderBaseLevel = lvl;
  }

  const rewards = parseRewards(raw.rewards, `${ctx}.rewards`);
  if (rewards) level.rewards = rewards;

  if (raw.staminaCost !== undefined) {
    const sc = int(raw.staminaCost, `${ctx}.staminaCost`);
    if (sc < 1 || sc > 5) fail(`${ctx}.staminaCost`, `must be 1..5, got ${sc}`);
    level.staminaCost = sc;
  }

  if (raw.nameKey !== undefined) {
    level.nameKey = str(raw.nameKey, `${ctx}.nameKey`) as LevelDefinition['nameKey'];
  }

  if (raw.briefKey !== undefined) {
    level.briefKey = str(raw.briefKey, `${ctx}.briefKey`) as LevelDefinition['briefKey'];
  }

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
