// Branch-coverage backfill for src/combatMarch/command.ts (83.8% branch). The march e2e suites
// (march/occupy-march/field-redispatch/...) all drive the *happy* dispatch, so what stayed unreached is
// almost entirely the refusal and rollback half of startMarch: the early validation throws, the degraded
// meta fallbacks, the E11000 / lost-claim races around the insert, and the pool-deduction rollback. Those
// paths need a Mongo write to fail on demand, which an e2e run cannot arrange.
//
// Unit test, not e2e: CommandService only ever touches `this.core` (2026-08-11 sibling-class split — see the
// file header of command.ts), so a hand-built WorldCore stub covers every dependency: `deps.cols` collections
// as vi.fn()s that return exactly what each case needs, plus the handful of core methods the command calls.
// Same style as occupation-battle.test.ts / combatSiege-damage-helpers-gaps.test.ts.
//
// Real @nw/shared code is used unmocked — SlgError/ErrorCode, findMarchPath (via computeMarchPath),
// marchDurationFromPath/marchMoraleFromPath, satchelCarryCapFor — so expected ids, timings and refusal codes
// come from the same functions the source uses rather than hand-copied constants.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ErrorCode,
  MARCH_MIN_TROOPS,
  OCCUPY_MIN_TROOPS,
  marchDurationFromPath,
  marchMoraleFromPath,
  proceduralTile,
  SLG_TEAM_STAMINA_COST,
  SLG_TEAM_STAMINA_MAX,
  type MarchKind,
} from '@nw/shared';
import { CommandService } from '../src/combatMarch/command';
import type { WorldCore } from '../src/core';
import type { MarchDoc, PlayerWorldDoc, StationedDoc, TileDoc, TeamTemplate } from '../src/db';

const W = 'w1';
const ACC = 'acc-1';
const ENEMY = 'enemy-1';
const NOW = 1_700_000_000_000;
const MAP = 20;

// (1,1) and (3,3) are ordinary `resource` cells of world 'w1' — no obstacle / center / city / stronghold /
// crossing special-casing anywhere in startMarchValidation, and A* walks between them freely.
const FROM = { x: 1, y: 1 };
const TO = { x: 3, y: 3 };
const tid = (x: number, y: number) => `${W}:${x}:${y}`;

function tile(x: number, y: number, overrides: Partial<TileDoc> = {}): TileDoc {
  return { _id: tid(x, y), worldId: W, x, y, type: 'resource', level: 1, ...overrides } as unknown as TileDoc;
}

function playerWorld(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${ACC}`, worldId: W, accountId: ACC, troops: 100_000, troopCap: 100_000,
    resources: {}, buildings: {}, rev: 3, lastTickAt: NOW,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

function flatTeam(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 't1', name: 'Vanguard',
    army: [{ col: 0, row: 0, unitType: 'sword', initialHp: 600 }],
    ...overrides,
  } as unknown as TeamTemplate;
}

/** Chainable cursor stub covering the `.find().project().sort().toArray()` shapes this module uses. */
function cursor<T>(docs: T[]) {
  const c = {
    project: () => c,
    sort: () => c,
    toArray: async () => docs,
  };
  return c;
}

interface WorldOpts {
  pw?: PlayerWorldDoc | null;
  tiles?: TileDoc[];
  /** Team-busy probes: marches / occupations / stationed (by {worldId,ownerId,teamId}). */
  busyMarch?: MarchDoc | null;
  busyHold?: unknown;
  busyStationed?: StationedDoc | null;
  /** stationed.findOneAndDelete result for the ADR-051 idle re-dispatch claim. */
  claim?: StationedDoc | null;
  stationedInsertErr?: unknown;
  marchInsertErr?: unknown;
  deductMatched?: number;
  saveFields?: () => Promise<unknown>;
  metaAvailable?: boolean;
  profile?: unknown;
  ownMarches?: MarchDoc[];
  visionSources?: { x: number; y: number; radius: number }[];
}

function fakeCore(o: WorldOpts = {}) {
  const tilesById = new Map((o.tiles ?? []).map((t) => [t._id, t]));
  const cols = {
    playerWorld: {
      findOne: vi.fn(async () => (o.pw === undefined ? playerWorld() : o.pw)),
      updateOne: vi.fn(async () => ({ matchedCount: o.deductMatched ?? 1 })),
      find: vi.fn(() => cursor([])),
    },
    tiles: {
      findOne: vi.fn(async (f: { _id: string }) => tilesById.get(f._id) ?? null),
      find: vi.fn(() => cursor([])),
    },
    marches: {
      findOne: vi.fn(async () => o.busyMarch ?? null),
      find: vi.fn(() => cursor(o.ownMarches ?? [])),
      insertOne: vi.fn(async () => {
        if (o.marchInsertErr) throw o.marchInsertErr;
        return {};
      }),
      deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
      findOneAndUpdate: vi.fn(async () => null),
      findOneAndDelete: vi.fn(async () => null),
    },
    occupations: { findOne: vi.fn(async () => o.busyHold ?? null) },
    stationed: {
      // Two distinct callers: the team-busy probe ({worldId,ownerId,teamId}) and startMarchValidation's
      // "is this cell already parked on" check ({_id}).
      findOne: vi.fn(async (f: Record<string, unknown>) => ('_id' in f ? null : (o.busyStationed ?? null))),
      findOneAndDelete: vi.fn(async () => o.claim ?? null),
      insertOne: vi.fn(async () => {
        if (o.stationedInsertErr) throw o.stationedInsertErr;
        return {};
      }),
    },
  };
  const core = {
    deps: { cols, mapW: MAP, mapH: MAP, now: () => NOW },
    marchSeq: 0,
    inBounds: vi.fn((x: number, y: number) => x >= 0 && y >= 0 && x < MAP && y < MAP),
    coordX: (t: string) => Number(t.split(':')[1]),
    coordY: (t: string) => Number(t.split(':')[2]),
    marchView: vi.fn((m: MarchDoc) => ({ id: m._id, kind: m.kind, arriveAt: m.arriveAt })),
    pushMarch: vi.fn(async () => undefined),
    visionObservers: vi.fn(async () => [] as string[]),
    computeVisionSources: vi.fn(async () => o.visionSources ?? []),
    familyMemberIds: vi.fn(async () => new Set<string>([ACC])),
    friendlyAccountIds: vi.fn(async () => new Set<string>()),
    isConnectedToSectTerritory: vi.fn(async () => true),
    targetFootprintCells: vi.fn((_t: unknown, x: number, y: number) => [{ x, y }]),
    sectPayoff: vi.fn(async () => ({ marchMult: 1 })),
    clearOccupancy: vi.fn(async () => undefined),
    setOccupancy: vi.fn(async () => undefined),
    meta: {
      available: o.metaAvailable ?? true,
      getSaveFields: vi.fn(o.saveFields ?? (async () => ({ cardInv: {}, equipmentInv: {} }))),
      getProfile: vi.fn(async () => o.profile ?? null),
    },
    gateway: { push: vi.fn(async () => undefined) },
    socialsvc: { getFamiliesByIds: vi.fn(async () => []) },
    settle: vi.fn(() => ({})),
    getMe: vi.fn(async () => ({ accountId: ACC })),
  };
  return { core: core as unknown as WorldCore, raw: core, cols };
}

/** Both tiles owned by the caller — the plain reinforce setup that walks the whole dispatch to the end. */
const OWNED_TILES = [tile(FROM.x, FROM.y, { ownerId: ACC }), tile(TO.x, TO.y, { ownerId: ACC })];

/** Argument `arg` of call `call` on a vi.fn() — the stubs above declare no parameters, so the inferred
 *  `mock.calls` tuple is empty and indexing it directly does not type-check. */
function argOf(fn: unknown, call: number, arg: number): unknown {
  const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[call]?.[arg];
}

async function expectSlg(p: Promise<unknown>, code: string, messageMatch?: RegExp): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: 'SlgError', code });
  if (messageMatch) await expect(p).rejects.toThrow(messageMatch);
}

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ACC, fromTile: tid(FROM.x, FROM.y), toTile: tid(TO.x, TO.y),
    kind: 'occupy', troops: 600, morale: 100, departAt: NOW - 10_000, arriveAt: NOW + 10_000,
    status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

let ctx: ReturnType<typeof fakeCore>;
let svc: CommandService;
function build(o: WorldOpts = {}): CommandService {
  ctx = fakeCore(o);
  svc = new CommandService(ctx.core);
  return svc;
}

beforeEach(() => {
  build();
});

describe('startMarch — pre-flight refusals', () => {
  it("sanity: the coordinates these tests use are ordinary walkable land, not a special tile", () => {
    expect(proceduralTile(W, FROM.x, FROM.y).type).toBe('resource');
    expect(proceduralTile(W, TO.x, TO.y).type).toBe('resource');
  });

  it("a non-marchable kind ('return') is refused before the player document is even read", async () => {
    const s = build();
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'return' as MarchKind, 600),
      ErrorCode.NOT_IMPLEMENTED,
      /not implemented/,
    );
    expect(ctx.cols.playerWorld.findOne).not.toHaveBeenCalled();
  });

  it('a caller who has not joined the world gets TILE_NOT_OWNED, no tile reads', async () => {
    const s = build({ pw: null });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600),
      ErrorCode.TILE_NOT_OWNED,
      /Not yet in the world/,
    );
    expect(ctx.cols.tiles.findOne).not.toHaveBeenCalled();
  });

  it('an out-of-bounds ORIGIN is refused (first operand of the bounds check)', async () => {
    const s = build();
    await expectSlg(s.startMarch(W, ACC, -1, 1, TO.x, TO.y, 'reinforce', 600), ErrorCode.OUT_OF_RANGE);
  });

  it('an in-bounds origin with an out-of-bounds TARGET is refused (second operand)', async () => {
    const s = build();
    await expectSlg(s.startMarch(W, ACC, FROM.x, FROM.y, MAP + 5, 1, 'reinforce', 600), ErrorCode.OUT_OF_RANGE);
    expect(ctx.raw.inBounds).toHaveBeenCalledTimes(2); // the first operand passed, so the second really ran
  });

  it("kind 'move' without a teamId is refused — there is no flat-pool move path", async () => {
    const s = build();
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'move', 600),
      ErrorCode.BAD_REQUEST,
      /Move requires a team/,
    );
    expect(ctx.cols.marches.findOne).not.toHaveBeenCalled();
  });

  it('a player document with no teams array at all → BAD_REQUEST before any busy probe runs', async () => {
    const s = build({ pw: playerWorld() }); // no `teams` field
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 600, 't1'),
      ErrorCode.BAD_REQUEST,
      /Team does not exist or is empty/,
    );
    expect(ctx.cols.marches.findOne).not.toHaveBeenCalled();
    expect(ctx.cols.stationed.findOne).not.toHaveBeenCalled();
  });

  it('an existing but EMPTY team is refused by the same guard', async () => {
    const s = build({ pw: playerWorld({ teams: [flatTeam({ army: [] })] } as Partial<PlayerWorldDoc>) });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 600, 't1'),
      ErrorCode.BAD_REQUEST,
      /Team does not exist or is empty/,
    );
  });

  it('a non-finite troop count is refused as NO_TROOPS (not silently floored to 0)', async () => {
    const s = build();
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', Number.NaN),
      ErrorCode.NO_TROOPS,
      /Invalid march troop count/,
    );
    expect(ctx.cols.marches.insertOne).not.toHaveBeenCalled();
  });

  it(`fewer than MARCH_MIN_TROOPS (${MARCH_MIN_TROOPS}) is refused by the same guard`, async () => {
    const s = build();
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', MARCH_MIN_TROOPS - 1),
      ErrorCode.NO_TROOPS,
    );
  });

  it('a pool smaller than the committed troops fails fast, before any path is computed', async () => {
    const s = build({ pw: playerWorld({ troops: 10 }), tiles: OWNED_TILES });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600),
      ErrorCode.NO_TROOPS,
      /Insufficient troops/,
    );
    expect(ctx.cols.marches.insertOne).not.toHaveBeenCalled();
    expect(ctx.cols.playerWorld.updateOne).not.toHaveBeenCalled();
  });
});

describe('startMarch — team dispatch with a degraded meta / empty card state', () => {
  const occupyTiles = [tile(FROM.x, FROM.y, { ownerId: ACC })]; // target unowned → a legal occupy

  it('a failing meta.getSaveFields does not abort the dispatch — the march flies without leader art', async () => {
    const s = build({
      pw: playerWorld({ teams: [flatTeam()] } as Partial<PlayerWorldDoc>),
      tiles: occupyTiles,
      saveFields: async () => {
        throw new Error('meta unreachable');
      },
    });
    const view = await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(view).toBeTruthy();
    expect(ctx.cols.marches.insertOne).toHaveBeenCalledTimes(1);
    const doc = argOf(ctx.cols.marches.insertOne, 0, 0) as MarchDoc;
    expect('leaderUnitType' in doc).toBe(false);
    // Troops come from the team template, not the caller's argument (0 above).
    expect(doc.troops).toBe(600);
  });

  it('a card team whose cardState is missing entirely carries 0 — no crash, no satchel refusal', async () => {
    const s = build({
      pw: playerWorld({
        teams: [flatTeam({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }, { col: 1, row: 0, initialHp: 5 }] })],
      } as Partial<PlayerWorldDoc>),
      tiles: occupyTiles,
    });
    // A card army has no minimum-troops gate (CHARACTER_CARDS_DESIGN §7.2), so this dispatches.
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(ctx.cols.marches.insertOne).toHaveBeenCalledTimes(1);
  });

  it('a card entry present in cardState but without currentTroops also counts as 0', async () => {
    const s = build({
      pw: playerWorld({
        teams: [flatTeam({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] })],
        cardState: { c1: {} },
      } as unknown as Partial<PlayerWorldDoc>),
      tiles: occupyTiles,
    });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(ctx.cols.marches.insertOne).toHaveBeenCalledTimes(1);
  });

  it('a card team over the satchel cap is refused and nothing is inserted', async () => {
    const s = build({
      pw: playerWorld({
        teams: [flatTeam({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] })],
        cardState: { c1: { currentTroops: 10_000_000 } },
      } as unknown as Partial<PlayerWorldDoc>),
      tiles: occupyTiles,
    });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1'),
      ErrorCode.SATCHEL_CAP_EXCEEDED,
    );
    expect(ctx.cols.marches.insertOne).not.toHaveBeenCalled();
  });
});

describe('startMarch — ADR-051 idle re-dispatch claim and its rollback', () => {
  const stationedDoc: StationedDoc = {
    _id: tid(FROM.x, FROM.y), worldId: W, ownerId: ACC, familyId: 'fam1', tile: tid(FROM.x, FROM.y),
    x: FROM.x, y: FROM.y, teamId: 't1', army: [{ col: 0, row: 0, unitType: 'sword', initialHp: 700 }],
    troops: 700, sinceAt: NOW - 60_000, leaderUnitType: 'sword', mode: 'idle',
  } as unknown as StationedDoc;

  function redispatchOpts(extra: WorldOpts = {}): WorldOpts {
    return {
      pw: playerWorld({ teams: [flatTeam()] } as Partial<PlayerWorldDoc>),
      // No owned origin tile on purpose: an idle re-dispatch departs from neutral field land.
      tiles: [],
      busyStationed: stationedDoc,
      claim: stationedDoc,
      ...extra,
    };
  }

  it('losing the findOneAndDelete race reports TEAM_BUSY and never inserts a march', async () => {
    const s = build(redispatchOpts({ claim: null }));
    await expectSlg(
      s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1'),
      ErrorCode.TEAM_BUSY,
      /no longer stationed/,
    );
    expect(ctx.cols.marches.insertOne).not.toHaveBeenCalled();
    expect(ctx.raw.clearOccupancy).not.toHaveBeenCalled();
  });

  it('a re-dispatch departs from where the team STANDS and carries its stationed snapshot forward', async () => {
    const s = build(redispatchOpts());
    await s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1'); // client-supplied origin (9,9) is ignored
    const doc = argOf(ctx.cols.marches.insertOne, 0, 0) as MarchDoc;
    expect(doc.fromTile).toBe(tid(FROM.x, FROM.y));
    expect(doc.troops).toBe(700); // the StationedDoc's post-encounter strength, not the roster template's 600
    expect(doc.leaderUnitType).toBe('sword');
    // Troops are already out of the pool, so no deduction is attempted. Narrowed from a blanket
    // "playerWorld was never written" when team stamina landed (2026-09-04): a re-dispatch DOES now write
    // playerWorld, for the stamina charge — see the stamina describe block. The claim this case makes is
    // about the troop pool specifically, so it asserts on the `$inc: { troops }` shape rather than on the
    // collection being untouched.
    const pwWrites = (ctx.cols.playerWorld.updateOne as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(pwWrites.every((c) => !((c[1] as { $inc?: Record<string, unknown> })?.$inc ?? {}).troops)).toBe(true);
    expect(ctx.raw.clearOccupancy).toHaveBeenCalledWith(W, stationedDoc.tile, stationedDoc.tile);
  });

  it('an E11000 on the march insert restores the claimed StationedDoc and its occupancy entry', async () => {
    const s = build(redispatchOpts({ marchInsertErr: { code: 11000 } }));
    await expectSlg(
      s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1'),
      ErrorCode.TEAM_BUSY,
      /already marching, occupying, or stationed/,
    );
    expect(ctx.cols.stationed.insertOne).toHaveBeenCalledWith(stationedDoc);
    expect(ctx.raw.setOccupancy).toHaveBeenCalledTimes(1);
    const occ = argOf(ctx.raw.setOccupancy, 0, 2) as { kind: string; teamId: string; familyId?: string };
    expect(occ).toMatchObject({ kind: 'stationed', teamId: 't1', familyId: 'fam1' });
  });

  it('a non-duplicate insert failure on a TEAM march is rethrown as-is after the restore', async () => {
    const boom = new Error('replica set stepped down');
    const s = build(redispatchOpts({ marchInsertErr: boom }));
    await expect(s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1')).rejects.toBe(boom);
    expect(ctx.cols.stationed.insertOne).toHaveBeenCalledTimes(1);
  });

  it('the restore swallows an E11000 (another unit took the cell) rather than masking the original error', async () => {
    const s = build(redispatchOpts({ marchInsertErr: { code: 11000 }, stationedInsertErr: { code: 11000 } }));
    await expectSlg(s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1'), ErrorCode.TEAM_BUSY);
    expect(ctx.raw.setOccupancy).not.toHaveBeenCalled(); // the cell belongs to whoever holds it now
  });
});

describe('startMarch — insert and pool-deduction failures on a flat-pool march', () => {
  it('a non-duplicate insert failure is rethrown unchanged (no TEAM_BUSY translation)', async () => {
    const boom = new Error('write concern failed');
    const s = build({ tiles: OWNED_TILES, marchInsertErr: boom });
    await expect(s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600)).rejects.toBe(boom);
    expect(ctx.cols.playerWorld.updateOne).not.toHaveBeenCalled();
  });

  it('an E11000 on a march with NO teamId is rethrown raw — the TEAM_BUSY translation is team-only', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const s = build({ tiles: OWNED_TILES, marchInsertErr: dup });
    await expect(s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600)).rejects.toBe(dup);
  });

  it('a lost pool-deduction race deletes the march just inserted and reports NO_TROOPS', async () => {
    const s = build({ tiles: OWNED_TILES, deductMatched: 0 });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600),
      ErrorCode.NO_TROOPS,
      /Insufficient troops/,
    );
    expect(ctx.cols.marches.insertOne).toHaveBeenCalledTimes(1);
    const inserted = argOf(ctx.cols.marches.insertOne, 0, 0) as MarchDoc;
    expect(ctx.cols.marches.deleteOne).toHaveBeenCalledWith({ _id: inserted._id });
    expect(ctx.raw.pushMarch).not.toHaveBeenCalled(); // no phantom march is pushed to the client
  });

  it('a successful flat dispatch deducts exactly the committed troops and times the arrival from the path', async () => {
    const s = build({ tiles: OWNED_TILES });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600);
    const doc = argOf(ctx.cols.marches.insertOne, 0, 0) as MarchDoc;
    expect(doc.arriveAt).toBe(NOW + marchDurationFromPath(doc.path!, 1) * 1000);
    expect(doc.morale).toBe(marchMoraleFromPath(doc.path!));
    expect(ctx.cols.playerWorld.updateOne).toHaveBeenCalledWith(
      { _id: `${W}:${ACC}`, troops: { $gte: 600 } },
      { $inc: { troops: -600, rev: 1 } },
    );
  });
});

describe('startMarch — the defender under_attack push', () => {
  const attackTiles = [tile(FROM.x, FROM.y, { ownerId: ACC }), tile(TO.x, TO.y, { ownerId: ENEMY })];

  it('an unresolvable attacker profile still pushes the warning, with blank name fields', async () => {
    const s = build({ tiles: attackTiles, profile: null });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'attack', OCCUPY_MIN_TROOPS);
    await vi.waitFor(() => expect(ctx.raw.gateway.push).toHaveBeenCalledTimes(1));
    expect(argOf(ctx.raw.gateway.push, 0, 0)).toBe(ENEMY);
    expect(argOf(ctx.raw.gateway.push, 0, 1)).toMatchObject({
      kind: 'under_attack', tile: tid(TO.x, TO.y), attackerName: '', attackerPublicId: '',
      troopsHint: OCCUPY_MIN_TROOPS,
    });
  });

  it('an offline meta service skips the profile lookup entirely and still warns the defender', async () => {
    const s = build({ tiles: attackTiles, metaAvailable: false });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'attack', OCCUPY_MIN_TROOPS);
    await vi.waitFor(() => expect(ctx.raw.gateway.push).toHaveBeenCalledTimes(1));
    expect(ctx.raw.meta.getProfile).not.toHaveBeenCalled();
  });

  it('a resolved profile fills the warning with the attacker display name and public id', async () => {
    const s = build({ tiles: attackTiles, profile: { displayName: 'Alice', publicId: 'PUB-7' } });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'attack', OCCUPY_MIN_TROOPS);
    await vi.waitFor(() => expect(ctx.raw.gateway.push).toHaveBeenCalledTimes(1));
    expect(argOf(ctx.raw.gateway.push, 0, 1)).toMatchObject({ attackerName: 'Alice', attackerPublicId: 'PUB-7' });
  });
});

describe('recallMarch — the three ways a march cannot be recalled', () => {
  it('a march that does not exist (or belongs to someone else) → MARCH_NOT_FOUND', async () => {
    const s = build();
    ctx.cols.marches.findOne.mockResolvedValueOnce(null as never);
    await expectSlg(s.recallMarch(W, ACC, 'm1'), ErrorCode.MARCH_NOT_FOUND, /cannot be recalled/);
    expect(ctx.cols.marches.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a march that is no longer in `marching` status → MARCH_NOT_FOUND (second operand)', async () => {
    const s = build();
    ctx.cols.marches.findOne.mockResolvedValueOnce(march({ status: 'arrived' }) as never);
    await expectSlg(s.recallMarch(W, ACC, 'm1'), ErrorCode.MARCH_NOT_FOUND);
    expect(ctx.cols.marches.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a leg that is already a return march → MARCH_NOT_FOUND (third operand)', async () => {
    const s = build();
    ctx.cols.marches.findOne.mockResolvedValueOnce(march({ kind: 'return' }) as never);
    await expectSlg(s.recallMarch(W, ACC, 'm1'), ErrorCode.MARCH_NOT_FOUND);
    expect(ctx.cols.marches.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('losing the atomic flip race (arrival processed first) → MARCH_NOT_FOUND, nothing pushed', async () => {
    const s = build();
    ctx.cols.marches.findOne.mockResolvedValueOnce(march() as never);
    ctx.cols.marches.findOneAndUpdate.mockResolvedValueOnce(null as never);
    await expectSlg(s.recallMarch(W, ACC, 'm1'), ErrorCode.MARCH_NOT_FOUND, /already arrived or been recalled/);
    expect(ctx.raw.pushMarch).not.toHaveBeenCalled();
  });

  it('a won flip swaps the endpoints, caps the return leg at the elapsed time, and clears the reached cell', async () => {
    const s = build();
    const outbound = march({
      departAt: NOW - 4_000, arriveAt: NOW + 6_000,
      path: [{ x: FROM.x, y: FROM.y }, { x: 2, y: 1 }], stepIndex: 1,
    });
    ctx.cols.marches.findOne.mockResolvedValueOnce(outbound as never);
    ctx.cols.marches.findOneAndUpdate.mockResolvedValueOnce(march({ kind: 'return' }) as never);
    await s.recallMarch(W, ACC, 'm1');
    const update = argOf(ctx.cols.marches.findOneAndUpdate, 0, 1) as { $set: Record<string, unknown> };
    expect(update.$set).toMatchObject({
      kind: 'return', fromTile: outbound.toTile, toTile: outbound.fromTile,
      departAt: NOW, arriveAt: NOW + 4_000,
    });
    expect(ctx.raw.clearOccupancy).toHaveBeenCalledWith(W, tid(2, 1), 'm1');
  });
});

describe('getMarches — the no-vision shortcut', () => {
  it('a viewer with no vision sources at all skips the enemy-march query entirely', async () => {
    const s = build({ ownMarches: [march()], visionSources: [] });
    const list = await s.getMarches(W, ACC);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mine: true });
    // Exactly one marches.find(): the caller's own legs. The enemy bounding-box query never ran.
    expect(ctx.cols.marches.find).toHaveBeenCalledTimes(1);
  });

  it('with vision sources the enemy query does run (the same code path, box present)', async () => {
    const s = build({ ownMarches: [], visionSources: [{ x: 5, y: 5, radius: 3 }] });
    await s.getMarches(W, ACC);
    expect(ctx.cols.marches.find).toHaveBeenCalledTimes(2);
    const enemyQuery = argOf(ctx.cols.marches.find, 1, 0) as Record<string, unknown>;
    expect(enemyQuery).toMatchObject({ worldId: W, status: 'marching', minX: { $lte: 8 }, maxX: { $gte: 2 } });
  });
});

describe('startMarch — team stamina (SLG_DESIGN §4.6)', () => {
  const occupyTiles = [tile(FROM.x, FROM.y, { ownerId: ACC })]; // target unowned → a legal occupy

  /** A team dispatch with an explicit stamina checkpoint on t1 (omit `state` for "never marched"). */
  function withStamina(
    state: { stamina?: number; staminaAt?: number } | undefined,
    extra: WorldOpts = {},
  ): CommandService {
    return build({
      pw: playerWorld({
        teams: [flatTeam()],
        ...(state ? { teamState: { t1: state } } : {}),
      } as unknown as Partial<PlayerWorldDoc>),
      tiles: occupyTiles,
      ...extra,
    });
  }

  /** The `$set` payload of the stamina write, or undefined if playerWorld was never written for it. */
  function staminaWrite(): Record<string, unknown> | undefined {
    const calls = (ctx.cols.playerWorld.updateOne as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const c of calls) {
      const update = c[1] as { $set?: Record<string, unknown> } | undefined;
      if (update?.$set && 'teamState.t1.stamina' in update.$set) return update.$set;
    }
    return undefined;
  }

  it('a team with no teamState entry at all reads as FULL and is charged one order', async () => {
    const s = withStamina(undefined);
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(staminaWrite()).toEqual({
      'teamState.t1.stamina': SLG_TEAM_STAMINA_MAX - SLG_TEAM_STAMINA_COST,
      'teamState.t1.staminaAt': NOW,
    });
  });

  it('the charge is taken from the REGENERATED figure, not the stale stored one', async () => {
    // Stored 0 five minutes ago → 5 points back at 1/min, still short of one order's 15.
    const s = withStamina({ stamina: 0, staminaAt: NOW - 5 * 60_000 });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1'),
      ErrorCode.TEAM_EXHAUSTED,
      /below the 15/,
    );
    // Stored 0 a full 20 minutes ago → 20 back: affordable, and the debit is 20-15, not 0-15.
    const s2 = withStamina({ stamina: 0, staminaAt: NOW - 20 * 60_000 });
    await s2.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(staminaWrite()).toEqual({
      'teamState.t1.stamina': 20 - SLG_TEAM_STAMINA_COST,
      'teamState.t1.staminaAt': NOW,
    });
  });

  it('exactly SLG_TEAM_STAMINA_COST is enough (the gate is >=, so the last order is affordable)', async () => {
    const s = withStamina({ stamina: SLG_TEAM_STAMINA_COST, staminaAt: NOW });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1');
    expect(staminaWrite()).toMatchObject({ 'teamState.t1.stamina': 0 });
  });

  it('one point short refuses with TEAM_EXHAUSTED and inserts no march at all', async () => {
    const s = withStamina({ stamina: SLG_TEAM_STAMINA_COST - 1, staminaAt: NOW });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1'),
      ErrorCode.TEAM_EXHAUSTED,
    );
    expect(ctx.cols.marches.insertOne).not.toHaveBeenCalled();
    expect(staminaWrite()).toBeUndefined();
  });

  it('a dispatch that fails to commit costs nothing — the charge lands after the pool debit', async () => {
    // deductMatched: 0 → the pool guard misses, startMarch rolls the march back and throws NO_TROOPS.
    const s = withStamina({ stamina: SLG_TEAM_STAMINA_MAX, staminaAt: NOW }, { deductMatched: 0 });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 600, 't1'),
      ErrorCode.NO_TROOPS,
    );
    expect(ctx.cols.marches.deleteOne).toHaveBeenCalledTimes(1);
    expect(staminaWrite()).toBeUndefined();
  });

  it('an idle re-dispatch is charged too — standing in the field is not a free order', async () => {
    const stationedDoc = {
      _id: tid(FROM.x, FROM.y), worldId: W, ownerId: ACC, tile: tid(FROM.x, FROM.y),
      x: FROM.x, y: FROM.y, teamId: 't1', army: [{ col: 0, row: 0, unitType: 'sword', initialHp: 700 }],
      troops: 700, sinceAt: NOW - 60_000, mode: 'idle',
    } as unknown as StationedDoc;
    const s = build({
      pw: playerWorld({ teams: [flatTeam()] } as Partial<PlayerWorldDoc>),
      tiles: [],
      busyStationed: stationedDoc,
      claim: stationedDoc,
    });
    await s.startMarch(W, ACC, 9, 9, TO.x, TO.y, 'move', 0, 't1');
    expect(staminaWrite()).toMatchObject({
      'teamState.t1.stamina': SLG_TEAM_STAMINA_MAX - SLG_TEAM_STAMINA_COST,
    });
  });

  it('a flat-pool march commands no team and is never charged', async () => {
    const s = build({ pw: playerWorld(), tiles: OWNED_TILES });
    await s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600);
    expect(ctx.cols.marches.insertOne).toHaveBeenCalledTimes(1);
    expect(staminaWrite()).toBeUndefined();
  });

  it('a busy team still reports TEAM_BUSY, not TEAM_EXHAUSTED, when both would block', async () => {
    // Recalling is the action that unblocks a busy team; waiting is the one for a tired team. With both
    // true the player must be told the former, so the busy gate has to stay ahead of the stamina gate.
    const s = withStamina({ stamina: 0, staminaAt: NOW }, { busyMarch: march({ teamId: 't1' }) });
    await expectSlg(
      s.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 0, 't1'),
      ErrorCode.TEAM_BUSY,
    );
  });
});
