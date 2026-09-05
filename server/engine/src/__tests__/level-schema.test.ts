/**
 * `campaign/levelSchema.ts` + its eight `levelSchema/*.ts` submodules: the runtime validator
 * that narrows level JSON (authored by the level editor, bundled at build time) into a
 * `LevelDefinition`. It had **zero** dedicated tests — the coverage it did have came from
 * whatever the campaign suites happened to load, i.e. the happy path only, which is why the
 * 2026-08-15 engine line-coverage round left it at 18%–85% and flagged it as a real gap.
 *
 * This file drives the REJECTION side, which is the whole point of the module: every `fail()`
 * call is a level that must not reach the engine. A validator whose accept path is tested and
 * whose reject paths are not is indistinguishable from `(raw) => raw as LevelDefinition` — it
 * would keep passing every test while letting a hand-edited board with an out-of-bounds cell,
 * a lane that is not an attack lane, or a 0-HP escort through to a mid-battle crash or a
 * silently unwinnable level. Each case asserts the error's `path`, not just that it threw:
 * the path IS the product here (it is what the level editor shows the author).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { LevelParseError, parseLevelDefinition } from '../campaign/levelSchema';
import {
  isObject,
  int,
  num,
  optBool,
  optStringArray,
  str,
  MAX_BASE_LEVEL,
} from '../campaign/levelSchema/helpers';
import { parseObjective } from '../campaign/levelSchema/objective';
import { parseCell, parseWaveEntry, parseWaves } from '../campaign/levelSchema/waves';
import { parseBoard } from '../campaign/levelSchema/board';
import { parseHazards } from '../campaign/levelSchema/hazards';
import { parseEscorts } from '../campaign/levelSchema/escorts';
import {
  parseAttackerArmy,
  parseDefenderBuildings,
  parseGarrison,
} from '../campaign/levelSchema/garrison';
import { parseRewards } from '../campaign/levelSchema/rewards';
import { BOARD_COLS, BOARD_ROWS, TOP_BUILDING_ROW } from '../config';

/** Assert `fn` rejects with a LevelParseError whose `path` is exactly `path`. */
function rejects(fn: () => unknown, path: string, messagePart?: string): void {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof LevelParseError, `expected LevelParseError, got ${String(err)}`);
      assert.equal(err.path, path);
      if (messagePart !== undefined) assert.ok(err.message.includes(messagePart), err.message);
      return true;
    },
    `expected a rejection at ${path}`,
  );
}

/** The minimal level every case below starts from: valid, campaign-shaped, one wave. */
function baseLevel(): Record<string, unknown> {
  return {
    id: 'lv_test',
    chapter: 1,
    seed: 42,
    objective: { kind: 'survive' },
    waves: { entries: [{ atTick: 0, unitType: 'infantry', col: 0, count: 1 }] },
  };
}

function withField(key: string, value: unknown): Record<string, unknown> {
  return { ...baseLevel(), [key]: value };
}

// ─────────────────────────────── helpers.ts ───────────────────────────────

test('isObject accepts plain objects and rejects null / arrays / primitives', () => {
  assert.equal(isObject({}), true);
  assert.equal(isObject({ a: 1 }), true);
  assert.equal(isObject(null), false);
  assert.equal(isObject([]), false);
  assert.equal(isObject('x'), false);
  assert.equal(isObject(undefined), false);
  assert.equal(isObject(7), false);
});

test('num rejects non-numbers and non-finite numbers, and passes finite ones through', () => {
  assert.equal(num(1.5, 'p'), 1.5);
  assert.equal(num(-0.25, 'p'), -0.25);
  rejects(() => num('1', 'p'), 'p', 'expected a finite number, got string');
  rejects(() => num(NaN, 'p'), 'p', 'got number');
  rejects(() => num(Infinity, 'p'), 'p');
  rejects(() => num(undefined, 'p'), 'p', 'got undefined');
});

test('int rejects fractions (via num first) and passes integers through', () => {
  assert.equal(int(3, 'p'), 3);
  assert.equal(int(-3, 'p'), -3);
  rejects(() => int(3.5, 'p'), 'p', 'expected an integer, got 3.5');
  rejects(() => int('3', 'p'), 'p', 'expected a finite number');
});

test('str rejects non-strings and passes strings (including empty) through', () => {
  assert.equal(str('', 'p'), '');
  assert.equal(str('a', 'p'), 'a');
  rejects(() => str(1, 'p'), 'p', 'expected a string, got number');
  rejects(() => str(null, 'p'), 'p', 'expected a string, got object');
});

test('optBool: undefined passes through as undefined, non-booleans are rejected', () => {
  assert.equal(optBool(undefined, 'p'), undefined);
  assert.equal(optBool(true, 'p'), true);
  assert.equal(optBool(false, 'p'), false);
  rejects(() => optBool('true', 'p'), 'p', 'expected a boolean, got string');
});

test('optStringArray: undefined passes, non-arrays reject, elements are validated by index', () => {
  assert.equal(optStringArray(undefined, 'p'), undefined);
  assert.deepEqual(optStringArray([], 'p'), []);
  assert.deepEqual(optStringArray(['a', 'b'], 'p'), ['a', 'b']);
  rejects(() => optStringArray('a', 'p'), 'p', 'expected an array of strings');
  rejects(() => optStringArray(['a', 2], 'p'), 'p[1]', 'expected a string, got number');
});

// ────────────────────────────── objective.ts ──────────────────────────────

test('parseObjective accepts every objective kind', () => {
  assert.deepEqual(parseObjective({ kind: 'survive' }, 'o'), { kind: 'survive' });
  assert.deepEqual(parseObjective({ kind: 'boss' }, 'o'), { kind: 'boss' });
  assert.deepEqual(parseObjective({ kind: 'destroy_base' }, 'o'), { kind: 'destroy_base' });
  assert.deepEqual(parseObjective({ kind: 'destroy_base', durationTicks: 600 }, 'o'), {
    kind: 'destroy_base',
    durationTicks: 600,
  });
  assert.deepEqual(parseObjective({ kind: 'timed_defense', durationTicks: 900 }, 'o'), {
    kind: 'timed_defense',
    durationTicks: 900,
  });
  assert.deepEqual(parseObjective({ kind: 'leak_limit', maxLeaks: 0 }, 'o'), {
    kind: 'leak_limit',
    maxLeaks: 0,
  });
  assert.deepEqual(parseObjective({ kind: 'escort', required: 'all' }, 'o'), {
    kind: 'escort',
    required: 'all',
  });
  assert.deepEqual(parseObjective({ kind: 'escort', required: 'any' }, 'o'), {
    kind: 'escort',
    required: 'any',
  });
  assert.deepEqual(parseObjective({ kind: 'escort', required: 2 }, 'o'), {
    kind: 'escort',
    required: 2,
  });
});

test('parseObjective rejects a non-object, a missing kind and an unknown kind', () => {
  rejects(() => parseObjective(null, 'o'), 'o', 'expected an objective object');
  rejects(() => parseObjective([], 'o'), 'o');
  rejects(() => parseObjective({}, 'o'), 'o.kind', 'expected a string');
  rejects(
    () => parseObjective({ kind: 'capture' }, 'o'),
    'o.kind',
    "unknown objective kind 'capture'",
  );
});

test('parseObjective rejects non-positive durations and out-of-range escort/leak counts', () => {
  rejects(
    () => parseObjective({ kind: 'destroy_base', durationTicks: 0 }, 'o'),
    'o.durationTicks',
    'must be > 0',
  );
  rejects(
    () => parseObjective({ kind: 'timed_defense', durationTicks: -1 }, 'o'),
    'o.durationTicks',
    'must be > 0',
  );
  rejects(
    () => parseObjective({ kind: 'timed_defense' }, 'o'),
    'o.durationTicks',
    'expected a finite number',
  );
  rejects(() => parseObjective({ kind: 'leak_limit', maxLeaks: -1 }, 'o'), 'o.maxLeaks', 'must be >= 0');
  rejects(() => parseObjective({ kind: 'escort', required: 0 }, 'o'), 'o.required', 'must be >= 1');
  rejects(
    () => parseObjective({ kind: 'escort', required: 'most' }, 'o'),
    'o.required',
    'expected a finite number',
  );
});

// ─────────────────────────────── waves.ts ────────────────────────────────

test('parseCell accepts in-bounds cells and rejects each bound separately', () => {
  assert.deepEqual(parseCell({ col: 0, row: 0 }, 'c'), { col: 0, row: 0 });
  assert.deepEqual(parseCell({ col: BOARD_COLS - 1, row: BOARD_ROWS - 1 }, 'c'), {
    col: BOARD_COLS - 1,
    row: BOARD_ROWS - 1,
  });
  rejects(() => parseCell('x', 'c'), 'c', 'expected a {col,row} cell');
  rejects(() => parseCell({ col: -1, row: 0 }, 'c'), 'c.col', 'out of bounds');
  rejects(() => parseCell({ col: BOARD_COLS, row: 0 }, 'c'), 'c.col', 'out of bounds');
  rejects(() => parseCell({ col: 0, row: -1 }, 'c'), 'c.row', 'out of bounds');
  rejects(() => parseCell({ col: 0, row: BOARD_ROWS }, 'c'), 'c.row', 'out of bounds');
});

test('parseWaveEntry accepts a full entry with every optional field', () => {
  const entry = parseWaveEntry(
    {
      atTick: 30,
      unitType: 'archer',
      col: 3,
      count: 2,
      spacingTicks: 0,
      crossWaypoints: [{ atRow: 5, toCol: 4 }],
      isBoss: true,
    },
    'w',
  );
  assert.deepEqual(entry, {
    atTick: 30,
    unitType: 'archer',
    col: 3,
    count: 2,
    spacingTicks: 0,
    crossWaypoints: [{ atRow: 5, toCol: 4 }],
    isBoss: true,
  });
});

test('parseWaveEntry omits the optional fields when they are absent', () => {
  const entry = parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 1 }, 'w');
  assert.deepEqual(entry, { atTick: 0, unitType: 'infantry', col: 0, count: 1 });
  assert.equal('spacingTicks' in entry, false);
  assert.equal('crossWaypoints' in entry, false);
  assert.equal('isBoss' in entry, false);
});

test('parseWaveEntry rejects every malformed field with its own path', () => {
  rejects(() => parseWaveEntry(7, 'w'), 'w', 'expected a wave entry object');
  rejects(
    () => parseWaveEntry({ atTick: -1, unitType: 'infantry', col: 0, count: 1 }, 'w'),
    'w.atTick',
    'must be >= 0',
  );
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'dragon', col: 0, count: 1 }, 'w'),
    'w.unitType',
    "unknown unit type 'dragon'",
  );
  // col 5/6 are the base columns — deliberately NOT attack lanes.
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 5, count: 1 }, 'w'),
    'w.col',
    'is not an attack lane',
  );
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 0 }, 'w'),
    'w.count',
    'must be > 0',
  );
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 1, spacingTicks: -1 }, 'w'),
    'w.spacingTicks',
    'must be >= 0',
  );
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 1, crossWaypoints: {} }, 'w'),
    'w.crossWaypoints',
    'expected an array',
  );
  rejects(
    () =>
      parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 1, crossWaypoints: [3] }, 'w'),
    'w.crossWaypoints[0]',
    'expected a {atRow,toCol} waypoint',
  );
  rejects(
    () =>
      parseWaveEntry(
        { atTick: 0, unitType: 'infantry', col: 0, count: 1, crossWaypoints: [{ atRow: 1 }] },
        'w',
      ),
    'w.crossWaypoints[0].toCol',
  );
  rejects(
    () => parseWaveEntry({ atTick: 0, unitType: 'infantry', col: 0, count: 1, isBoss: 'yes' }, 'w'),
    'w.isBoss',
    'expected a boolean',
  );
});

test('parseWaves requires >=1 entry for campaign levels but allows none for siege battles', () => {
  const one = [{ atTick: 0, unitType: 'infantry', col: 0, count: 1 }];
  assert.equal(parseWaves({ entries: one }, 'w', false).entries.length, 1);
  assert.deepEqual(parseWaves({ entries: [] }, 'w', true), { entries: [] });
  rejects(() => parseWaves({ entries: [] }, 'w', false), 'w.entries', 'at least one wave entry');
  rejects(() => parseWaves([], 'w', false), 'w', 'expected a waves object');
  rejects(() => parseWaves({ entries: {} }, 'w', false), 'w.entries', 'expected an array of wave entries');
  // The index of the bad entry is part of the path.
  rejects(() => parseWaves({ entries: [...one, 5] }, 'w', false), 'w.entries[1]');
});

// ─────────────────────────────── board.ts ────────────────────────────────

test('parseBoard returns undefined when absent and accepts a fully populated override', () => {
  assert.equal(parseBoard(undefined, 'b'), undefined);
  assert.deepEqual(parseBoard({}, 'b'), {});
  const board = parseBoard(
    {
      activeLanes: [0, 11],
      laneLength: { 0: 4, 11: 16 },
      cellMask: { blocked: [{ col: 1, row: 2 }], noBuild: [{ col: 3, row: 4 }] },
    },
    'b',
  );
  assert.deepEqual(board, {
    activeLanes: [0, 11],
    laneLength: { 0: 4, 11: 16 },
    cellMask: { blocked: [{ col: 1, row: 2 }], noBuild: [{ col: 3, row: 4 }] },
  });
});

test('parseBoard accepts a cellMask with only one of the two lists', () => {
  assert.deepEqual(parseBoard({ cellMask: { blocked: [] } }, 'b'), { cellMask: { blocked: [] } });
  assert.deepEqual(parseBoard({ cellMask: { noBuild: [] } }, 'b'), { cellMask: { noBuild: [] } });
  assert.deepEqual(parseBoard({ cellMask: {} }, 'b'), { cellMask: {} });
});

test('parseBoard rejects malformed board / activeLanes / cellMask shapes', () => {
  rejects(() => parseBoard('b', 'b'), 'b', 'expected a board object');
  rejects(() => parseBoard({ activeLanes: 0 }, 'b'), 'b.activeLanes', 'expected an array of lane columns');
  rejects(() => parseBoard({ activeLanes: [0, 5] }, 'b'), 'b.activeLanes[1]', 'lane 5 is not an attack lane');
  rejects(() => parseBoard({ activeLanes: ['0'] }, 'b'), 'b.activeLanes[0]', 'expected a finite number');
  rejects(() => parseBoard({ cellMask: [] }, 'b'), 'b.cellMask', 'expected a cellMask object');
  rejects(() => parseBoard({ cellMask: { blocked: {} } }, 'b'), 'b.cellMask.blocked', 'expected an array of cells');
  rejects(() => parseBoard({ cellMask: { noBuild: {} } }, 'b'), 'b.cellMask.noBuild', 'expected an array of cells');
  rejects(
    () => parseBoard({ cellMask: { blocked: [{ col: BOARD_COLS, row: 0 }] } }, 'b'),
    'b.cellMask.blocked[0].col',
  );
});

test('parseBoard rejects laneLength keys that are not attack lanes and lengths that put spawnRow out of range', () => {
  rejects(() => parseBoard({ laneLength: [] }, 'b'), 'b.laneLength', 'expected a col→length object');
  rejects(
    () => parseBoard({ laneLength: { abc: 4 } }, 'b'),
    'b.laneLength',
    "key 'abc' is not a valid attack lane column",
  );
  rejects(
    () => parseBoard({ laneLength: { 5: 4 } }, 'b'),
    'b.laneLength',
    "key '5' is not a valid attack lane column",
  );
  rejects(() => parseBoard({ laneLength: { 0: '4' } }, 'b'), 'b.laneLength.0', 'expected a finite number');
  // spawnRow = BOARD_ROWS - len, and must land in 2..16.
  rejects(
    () => parseBoard({ laneLength: { 0: BOARD_ROWS - 1 } }, 'b'),
    'b.laneLength.0',
    'must give spawnRow 2..16',
  );
  rejects(() => parseBoard({ laneLength: { 0: 1 } }, 'b'), 'b.laneLength.0', 'must give spawnRow 2..16');
  // ...and the two boundaries themselves are accepted.
  assert.deepEqual(parseBoard({ laneLength: { 0: BOARD_ROWS - 2 } }, 'b'), {
    laneLength: { 0: BOARD_ROWS - 2 },
  });
  assert.deepEqual(parseBoard({ laneLength: { 0: BOARD_ROWS - 16 } }, 'b'), {
    laneLength: { 0: BOARD_ROWS - 16 },
  });
});

// ─────────────────────────────── hazards.ts ──────────────────────────────

test('parseHazards returns undefined when absent and preserves the optional modifiers', () => {
  assert.equal(parseHazards(undefined, 'h'), undefined);
  assert.deepEqual(parseHazards([], 'h'), []);
  assert.deepEqual(parseHazards([{ col: 1, rowRange: [2, 5], effect: 'lava', dps: 1.5 }], 'h'), [
    { col: 1, rowRange: [2, 5], effect: 'lava', dps: 1.5 },
  ]);
  assert.deepEqual(
    parseHazards([{ col: 1, rowRange: [2, 5], effect: 'speed', speedMult: 0.5, rangeMod: -1 }], 'h'),
    [{ col: 1, rowRange: [2, 5], effect: 'speed', speedMult: 0.5, rangeMod: -1 }],
  );
  // ...and drops nothing when none of them is present.
  assert.deepEqual(parseHazards([{ col: 0, rowRange: [0, 1], effect: 'fog' }], 'h'), [
    { col: 0, rowRange: [0, 1], effect: 'fog' },
  ]);
});

test('parseHazards rejects a non-array, bad entries, a bad rowRange and an unknown effect', () => {
  rejects(() => parseHazards({}, 'h'), 'h', 'expected an array of hazards');
  rejects(() => parseHazards([1], 'h'), 'h[0]', 'expected a hazard object');
  rejects(
    () => parseHazards([{ col: 0, rowRange: [1], effect: 'fog' }], 'h'),
    'h[0].rowRange',
    'expected a [from,to] tuple',
  );
  rejects(() => parseHazards([{ col: 0, rowRange: 'x', effect: 'fog' }], 'h'), 'h[0].rowRange');
  rejects(
    () => parseHazards([{ col: 0, rowRange: [0, 1], effect: 'ice' }], 'h'),
    'h[0].effect',
    "unknown hazard effect 'ice'",
  );
  rejects(() => parseHazards([{ col: 0, rowRange: [0, 1.5], effect: 'fog' }], 'h'), 'h[0].rowRange[1]');
});

// ─────────────────────────────── escorts.ts ──────────────────────────────

test('parseEscorts returns undefined when absent, [] when empty, and keeps an ascending path', () => {
  assert.equal(parseEscorts(undefined, 'e'), undefined);
  assert.deepEqual(parseEscorts([], 'e'), []);
  const spec = parseEscorts(
    [
      {
        id: 'cart',
        hp: 100,
        speed: 0.5,
        startCol: 0,
        startRow: 1,
        path: [
          { col: 0, row: 3 },
          { col: 1, row: 5 },
        ],
      },
    ],
    'e',
  );
  assert.deepEqual(spec, [
    {
      id: 'cart',
      hp: 100,
      speed: 0.5,
      startCol: 0,
      startRow: 1,
      path: [
        { col: 0, row: 3 },
        { col: 1, row: 5 },
      ],
    },
  ]);
  // An empty path never enters the ascending-rows loop.
  assert.deepEqual(parseEscorts([{ id: 'c', hp: 1, speed: 1, startCol: 0, startRow: 0, path: [] }], 'e'), [
    { id: 'c', hp: 1, speed: 1, startCol: 0, startRow: 0, path: [] },
  ]);
});

test('parseEscorts rejects each malformed scalar field with its own path', () => {
  const ok = { id: 'cart', hp: 10, speed: 1, startCol: 0, startRow: 0 };
  rejects(() => parseEscorts({}, 'e'), 'e', 'expected an array of escort specs');
  rejects(() => parseEscorts(['x'], 'e'), 'e[0]', 'expected an escort spec object');
  rejects(() => parseEscorts([{ ...ok, id: '' }], 'e'), 'e[0].id', 'must be a non-empty string');
  rejects(() => parseEscorts([{ ...ok, hp: 0 }], 'e'), 'e[0].hp', 'must be > 0');
  rejects(() => parseEscorts([{ ...ok, speed: 0 }], 'e'), 'e[0].speed', 'must be > 0');
  rejects(() => parseEscorts([{ ...ok, startCol: -1 }], 'e'), 'e[0].startCol', 'out of bounds');
  rejects(() => parseEscorts([{ ...ok, startCol: BOARD_COLS }], 'e'), 'e[0].startCol', 'out of bounds');
  rejects(() => parseEscorts([{ ...ok, startRow: -1 }], 'e'), 'e[0].startRow', 'out of bounds');
  rejects(() => parseEscorts([{ ...ok, startRow: BOARD_ROWS }], 'e'), 'e[0].startRow', 'out of bounds');
});

test('parseEscorts rejects a malformed path, out-of-bounds waypoints and non-ascending rows', () => {
  const ok = { id: 'cart', hp: 10, speed: 1, startCol: 0, startRow: 0 };
  rejects(() => parseEscorts([{ ...ok, path: {} }], 'e'), 'e[0].path', 'expected an array of waypoints');
  rejects(() => parseEscorts([{ ...ok, path: [1] }], 'e'), 'e[0].path[0]', 'expected a {col, row} waypoint');
  rejects(
    () => parseEscorts([{ ...ok, path: [{ col: BOARD_COLS, row: 0 }] }], 'e'),
    'e[0].path[0].col',
    'out of bounds',
  );
  rejects(() => parseEscorts([{ ...ok, path: [{ col: -1, row: 0 }] }], 'e'), 'e[0].path[0].col', 'out of bounds');
  rejects(
    () => parseEscorts([{ ...ok, path: [{ col: 0, row: BOARD_ROWS }] }], 'e'),
    'e[0].path[0].row',
    'out of bounds',
  );
  rejects(() => parseEscorts([{ ...ok, path: [{ col: 0, row: -1 }] }], 'e'), 'e[0].path[0].row', 'out of bounds');
  rejects(
    () =>
      parseEscorts(
        [
          {
            ...ok,
            path: [
              { col: 0, row: 5 },
              { col: 0, row: 5 },
            ],
          },
        ],
        'e',
      ),
    'e[0].path[1].row',
    'strictly ascending',
  );
  rejects(
    () =>
      parseEscorts(
        [
          {
            ...ok,
            path: [
              { col: 0, row: 5 },
              { col: 0, row: 4 },
            ],
          },
        ],
        'e',
      ),
    'e[0].path[1].row',
    'strictly ascending',
  );
});

// ─────────────────────────────── garrison.ts ─────────────────────────────

test('parseGarrison / parseAttackerArmy share the entry shape and both handle absent + empty', () => {
  assert.equal(parseGarrison(undefined, 'g'), undefined);
  assert.equal(parseAttackerArmy(undefined, 'a'), undefined);
  assert.deepEqual(parseGarrison([], 'g'), []);
  assert.deepEqual(parseAttackerArmy([], 'a'), []);
  assert.deepEqual(parseGarrison([{ unitType: 'infantry', col: 0, row: 1 }], 'g'), [
    { unitType: 'infantry', col: 0, row: 1 },
  ]);
  assert.deepEqual(parseAttackerArmy([{ unitType: 'archer', col: 11, row: 16, initialHp: 250 }], 'a'), [
    { unitType: 'archer', col: 11, row: 16, initialHp: 250 },
  ]);
});

test('the garrison entry parser rejects every malformed field, through both entry points', () => {
  rejects(() => parseGarrison({}, 'g'), 'g', 'expected an array of garrison entries');
  rejects(() => parseAttackerArmy({}, 'a'), 'a', 'expected an array of attacker army entries');
  rejects(() => parseGarrison([0], 'g'), 'g[0]', 'expected a garrison entry object');
  rejects(() => parseAttackerArmy([0], 'a'), 'a[0]', 'expected a garrison entry object');
  rejects(
    () => parseGarrison([{ unitType: 'dragon', col: 0, row: 1 }], 'g'),
    'g[0].unitType',
    "unknown unit type 'dragon'",
  );
  rejects(() => parseGarrison([{ unitType: 'infantry', col: 6, row: 1 }], 'g'), 'g[0].col', 'is not an attack lane');
  rejects(
    () => parseGarrison([{ unitType: 'infantry', col: 0, row: 0 }], 'g'),
    'g[0].row',
    'garrison row must be 1..',
  );
  rejects(
    () => parseGarrison([{ unitType: 'infantry', col: 0, row: TOP_BUILDING_ROW }], 'g'),
    'g[0].row',
    'garrison row must be 1..',
  );
  rejects(
    () => parseGarrison([{ unitType: 'infantry', col: 0, row: 1, initialHp: 0 }], 'g'),
    'g[0].initialHp',
    'must be > 0',
  );
});

test('parseDefenderBuildings handles absent + empty and validates type and lane', () => {
  assert.equal(parseDefenderBuildings(undefined, 'd'), undefined);
  assert.deepEqual(parseDefenderBuildings([], 'd'), []);
  assert.deepEqual(parseDefenderBuildings([{ buildingType: 'arrow_tower', col: 4 }], 'd'), [
    { buildingType: 'arrow_tower', col: 4 },
  ]);
  rejects(() => parseDefenderBuildings({}, 'd'), 'd', 'expected an array of defender building entries');
  rejects(() => parseDefenderBuildings([1], 'd'), 'd[0]', 'expected a defender building entry object');
  rejects(
    () => parseDefenderBuildings([{ buildingType: 'castle', col: 0 }], 'd'),
    'd[0].buildingType',
    "unknown building type 'castle'",
  );
  rejects(
    () => parseDefenderBuildings([{ buildingType: 'barracks', col: 5 }], 'd'),
    'd[0].col',
    'is not an attack lane',
  );
});

// ─────────────────────────────── rewards.ts ──────────────────────────────

test('parseRewards returns undefined when absent and carries every optional field through', () => {
  assert.equal(parseRewards(undefined, 'r'), undefined);
  assert.deepEqual(parseRewards({}, 'r'), {});
  assert.deepEqual(
    parseRewards(
      {
        coins: 50,
        unlockSkinId: 'skin_a',
        unlockStoryKey: 'story.a',
        starThresholds: [10, 50, 90],
        materials: { iron: 2, wood: 0 },
      },
      'r',
    ),
    {
      coins: 50,
      unlockSkinId: 'skin_a',
      unlockStoryKey: 'story.a',
      starThresholds: [10, 50, 90],
      materials: { iron: 2, wood: 0 },
    },
  );
  // Equal thresholds are non-decreasing, so they pass.
  assert.deepEqual(parseRewards({ starThresholds: [50, 50, 50] }, 'r'), { starThresholds: [50, 50, 50] });
});

test('parseRewards rejects a bad shape, bad thresholds and bad materials', () => {
  rejects(() => parseRewards([], 'r'), 'r', 'expected a rewards object');
  rejects(() => parseRewards({ coins: 1.5 }, 'r'), 'r.coins', 'expected an integer');
  rejects(() => parseRewards({ unlockSkinId: 1 }, 'r'), 'r.unlockSkinId', 'expected a string');
  rejects(() => parseRewards({ unlockStoryKey: 1 }, 'r'), 'r.unlockStoryKey', 'expected a string');
  rejects(() => parseRewards({ starThresholds: [1, 2] }, 'r'), 'r.starThresholds', 'expected a [s1,s2,s3] tuple');
  rejects(() => parseRewards({ starThresholds: {} }, 'r'), 'r.starThresholds', 'expected a [s1,s2,s3] tuple');
  rejects(() => parseRewards({ starThresholds: [-1, 2, 3] }, 'r'), 'r.starThresholds[0]', 'HP% must be 0..100');
  rejects(() => parseRewards({ starThresholds: [1, 2, 101] }, 'r'), 'r.starThresholds[2]', 'HP% must be 0..100');
  rejects(() => parseRewards({ starThresholds: [90, 50, 10] }, 'r'), 'r.starThresholds', 'must be non-decreasing');
  // ...and the second half of that comparison on its own (1★ ≤ 2★ but 2★ > 3★).
  rejects(() => parseRewards({ starThresholds: [10, 90, 50] }, 'r'), 'r.starThresholds', 'must be non-decreasing');
  rejects(() => parseRewards({ materials: [] }, 'r'), 'r.materials', 'expected a material→amount object');
  rejects(() => parseRewards({ materials: { iron: -1 } }, 'r'), 'r.materials.iron', 'must be >= 0');
  rejects(() => parseRewards({ materials: { iron: 'x' } }, 'r'), 'r.materials.iron', 'expected a finite number');
});

// ─────────────────────── parseLevelDefinition (orchestrator) ─────────────

test('parseLevelDefinition accepts the minimal campaign level and drops nothing from it', () => {
  const level = parseLevelDefinition(baseLevel());
  assert.deepEqual(level, {
    id: 'lv_test',
    chapter: 1,
    seed: 42,
    objective: { kind: 'survive' },
    waves: { entries: [{ atTick: 0, unitType: 'infantry', col: 0, count: 1 }] },
  });
});

test('parseLevelDefinition rejects a non-object and an empty id, with the default ctx in the path', () => {
  rejects(() => parseLevelDefinition(null), 'level', 'expected a level object');
  rejects(() => parseLevelDefinition([]), 'level');
  rejects(() => parseLevelDefinition({ ...baseLevel(), id: '' }), 'level.id', 'must be a non-empty id');
  rejects(() => parseLevelDefinition({ ...baseLevel(), chapter: 1.5 }), 'level.chapter');
  rejects(() => parseLevelDefinition({ ...baseLevel(), seed: 'x' }), 'level.seed');
  // ...and a caller-supplied ctx replaces it everywhere.
  rejects(() => parseLevelDefinition({ ...baseLevel(), id: 1 }, 'ch1.lv2'), 'ch1.lv2.id');
});

test('parseLevelDefinition treats attackerArmy or battleTimeoutTicks as the siege marker that allows zero waves', () => {
  // Neither marker → an empty waves list is a broken campaign level.
  rejects(() => parseLevelDefinition({ ...baseLevel(), waves: { entries: [] } }), 'level.waves.entries');
  const withArmy = parseLevelDefinition({
    ...baseLevel(),
    waves: { entries: [] },
    attackerArmy: [{ unitType: 'infantry', col: 0, row: 2 }],
  });
  assert.deepEqual(withArmy.waves.entries, []);
  assert.deepEqual(withArmy.attackerArmy, [{ unitType: 'infantry', col: 0, row: 2 }]);
  const withTimeout = parseLevelDefinition({
    ...baseLevel(),
    waves: { entries: [] },
    battleTimeoutTicks: 3600,
  });
  assert.equal(withTimeout.battleTimeoutTicks, 3600);
  rejects(() => parseLevelDefinition(withField('battleTimeoutTicks', 0)), 'level.battleTimeoutTicks', 'must be > 0');
});

test('parseLevelDefinition validates startInk / inkRegenMult and keeps 0 as a legal floor', () => {
  assert.equal(parseLevelDefinition(withField('startInk', 0)).startInk, 0);
  assert.equal(parseLevelDefinition(withField('inkRegenMult', 0)).inkRegenMult, 0);
  assert.equal(parseLevelDefinition(withField('inkRegenMult', 1.5)).inkRegenMult, 1.5);
  rejects(() => parseLevelDefinition(withField('startInk', -1)), 'level.startInk', 'must be >= 0');
  rejects(() => parseLevelDefinition(withField('inkRegenMult', -0.5)), 'level.inkRegenMult', 'must be >= 0');
  // Absent → the field is not materialised at all (the engine's own default applies).
  const bare = parseLevelDefinition(baseLevel());
  assert.equal('startInk' in bare, false);
  assert.equal('inkRegenMult' in bare, false);
});

test('parseLevelDefinition carries loadout / bannedCards through and validates their elements', () => {
  const level = parseLevelDefinition({ ...baseLevel(), loadout: ['c1'], bannedCards: ['c2'] });
  assert.deepEqual(level.loadout, ['c1']);
  assert.deepEqual(level.bannedCards, ['c2']);
  // An empty array is still truthy, so it is carried through as an explicit "no cards".
  assert.deepEqual(parseLevelDefinition(withField('loadout', [])).loadout, []);
  rejects(() => parseLevelDefinition(withField('loadout', 'c1')), 'level.loadout');
  rejects(() => parseLevelDefinition(withField('bannedCards', [1])), 'level.bannedCards[0]');
});

test('parseLevelDefinition validates the levelSpells list', () => {
  const level = parseLevelDefinition(withField('levelSpells', [{ cardId: 'meteor', initialCount: 0 }]));
  assert.deepEqual(level.levelSpells, [{ cardId: 'meteor', initialCount: 0 }]);
  rejects(() => parseLevelDefinition(withField('levelSpells', {})), 'level.levelSpells', 'expected an array');
  rejects(
    () => parseLevelDefinition(withField('levelSpells', [1])),
    'level.levelSpells[0]',
    'expected a {cardId, initialCount} object',
  );
  rejects(
    () => parseLevelDefinition(withField('levelSpells', [{ cardId: 'm', initialCount: -1 }])),
    'level.levelSpells[0].initialCount',
    'must be >= 0',
  );
  rejects(
    () => parseLevelDefinition(withField('levelSpells', [{ cardId: 1, initialCount: 1 }])),
    'level.levelSpells[0].cardId',
  );
});

test('parseLevelDefinition validates enemyScale and only materialises it when a multiplier is present', () => {
  assert.deepEqual(parseLevelDefinition(withField('enemyScale', { hp: 1.5 })).enemyScale, { hp: 1.5 });
  assert.deepEqual(parseLevelDefinition(withField('enemyScale', { damage: 2 })).enemyScale, { damage: 2 });
  assert.deepEqual(parseLevelDefinition(withField('enemyScale', { hp: 1.2, damage: 1.3 })).enemyScale, {
    hp: 1.2,
    damage: 1.3,
  });
  // `{}` parses, but must NOT leave an empty enemyScale object on the level.
  assert.equal('enemyScale' in parseLevelDefinition(withField('enemyScale', {})), false);
  rejects(() => parseLevelDefinition(withField('enemyScale', [])), 'level.enemyScale', 'expected an {hp?, damage?} object');
  rejects(() => parseLevelDefinition(withField('enemyScale', { hp: 0 })), 'level.enemyScale.hp', 'must be > 0');
  rejects(
    () => parseLevelDefinition(withField('enemyScale', { damage: 0 })),
    'level.enemyScale.damage',
    'must be > 0',
  );
});

test('parseLevelDefinition drops empty escort / garrison / attackerArmy / defenderBuildings lists', () => {
  const level = parseLevelDefinition({
    ...baseLevel(),
    escorts: [],
    garrison: [],
    attackerArmy: [],
    defenderBuildings: [],
  });
  assert.equal('escorts' in level, false);
  assert.equal('garrison' in level, false);
  assert.equal('attackerArmy' in level, false);
  assert.equal('defenderBuildings' in level, false);
});

test('parseLevelDefinition keeps non-empty escort / garrison / defenderBuildings lists', () => {
  const level = parseLevelDefinition({
    ...baseLevel(),
    escorts: [{ id: 'cart', hp: 10, speed: 1, startCol: 0, startRow: 0 }],
    garrison: [{ unitType: 'infantry', col: 0, row: 1 }],
    defenderBuildings: [{ buildingType: 'barracks', col: 1 }],
    board: { activeLanes: [0] },
    hazards: [{ col: 0, rowRange: [0, 1], effect: 'fog' }],
  });
  assert.equal(level.escorts?.length, 1);
  assert.equal(level.garrison?.length, 1);
  assert.equal(level.defenderBuildings?.length, 1);
  assert.deepEqual(level.board, { activeLanes: [0] });
  assert.equal(level.hazards?.length, 1);
  // ...and when board/hazards are absent the keys are not materialised.
  const bare = parseLevelDefinition(baseLevel());
  assert.equal('board' in bare, false);
  assert.equal('hazards' in bare, false);
});

test('parseLevelDefinition range-checks defenderBaseLevel and defenderBaseHp', () => {
  assert.equal(parseLevelDefinition(withField('defenderBaseLevel', 0)).defenderBaseLevel, 0);
  assert.equal(
    parseLevelDefinition(withField('defenderBaseLevel', MAX_BASE_LEVEL)).defenderBaseLevel,
    MAX_BASE_LEVEL,
  );
  rejects(() => parseLevelDefinition(withField('defenderBaseLevel', -1)), 'level.defenderBaseLevel', 'must be 0..');
  rejects(
    () => parseLevelDefinition(withField('defenderBaseLevel', MAX_BASE_LEVEL + 1)),
    'level.defenderBaseLevel',
    'must be 0..',
  );
  assert.equal(parseLevelDefinition(withField('defenderBaseHp', 1)).defenderBaseHp, 1);
  assert.equal(parseLevelDefinition(withField('defenderBaseHp', 100_000)).defenderBaseHp, 100_000);
  rejects(() => parseLevelDefinition(withField('defenderBaseHp', 0)), 'level.defenderBaseHp', 'must be 1..100000');
  rejects(
    () => parseLevelDefinition(withField('defenderBaseHp', 100_001)),
    'level.defenderBaseHp',
    'must be 1..100000',
  );
});

test('parseLevelDefinition range-checks staminaCost at both ends', () => {
  assert.equal(parseLevelDefinition(withField('staminaCost', 1)).staminaCost, 1);
  assert.equal(parseLevelDefinition(withField('staminaCost', 5)).staminaCost, 5);
  rejects(() => parseLevelDefinition(withField('staminaCost', 0)), 'level.staminaCost', 'must be 1..5');
  rejects(() => parseLevelDefinition(withField('staminaCost', 6)), 'level.staminaCost', 'must be 1..5');
});

test('parseLevelDefinition carries rewards, nameKey, briefKey and each story key through', () => {
  const level = parseLevelDefinition({
    ...baseLevel(),
    rewards: { coins: 10 },
    nameKey: 'lv.name',
    briefKey: 'lv.brief',
    story: { introKey: 'i', outroKey: 'o', realLayerKey: 'r' },
  });
  assert.deepEqual(level.rewards, { coins: 10 });
  assert.equal(level.nameKey, 'lv.name');
  assert.equal(level.briefKey, 'lv.brief');
  assert.deepEqual(level.story, { introKey: 'i', outroKey: 'o', realLayerKey: 'r' });
  // An empty story object still materialises `story` (each key is independently optional).
  assert.deepEqual(parseLevelDefinition(withField('story', {})).story, {});
  assert.deepEqual(parseLevelDefinition(withField('story', { introKey: 'i' })).story, { introKey: 'i' });
  assert.deepEqual(parseLevelDefinition(withField('story', { outroKey: 'o' })).story, { outroKey: 'o' });
  assert.deepEqual(parseLevelDefinition(withField('story', { realLayerKey: 'r' })).story, {
    realLayerKey: 'r',
  });
});

test('parseLevelDefinition rejects malformed rewards / nameKey / briefKey / story', () => {
  rejects(() => parseLevelDefinition(withField('rewards', [])), 'level.rewards');
  rejects(() => parseLevelDefinition(withField('nameKey', 1)), 'level.nameKey');
  rejects(() => parseLevelDefinition(withField('briefKey', 1)), 'level.briefKey');
  rejects(() => parseLevelDefinition(withField('story', [])), 'level.story', 'expected a story object');
  rejects(() => parseLevelDefinition(withField('story', { introKey: 1 })), 'level.story.introKey');
  rejects(() => parseLevelDefinition(withField('story', { outroKey: 1 })), 'level.story.outroKey');
  rejects(() => parseLevelDefinition(withField('story', { realLayerKey: 1 })), 'level.story.realLayerKey');
});
