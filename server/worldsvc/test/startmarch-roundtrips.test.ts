// `POST /world/march` round-trip shape (2026-09-17).
//
// What this file guards is a COST, not a behaviour, and it exists because the behaviour tests cannot
// see the cost at all: `combatMarch-command-branch-gaps.test.ts` is just as green whether startMarch
// issues its reads one after another or all at once.
//
// Why the cost is the thing: all seven services share one Atlas shared-tier cluster, so its 100 ops/sec
// token bucket belongs to the whole backend. Measured on live s2-0 on 2026-09-17, roughly one operation
// in 150 stalls for ~0.7s (4 of 600 probe pings) — which makes a route's p90 "how many SERIAL waves does it issue" times that
// hit rate, not a function of how heavy its queries are. That is why `POST /world/march` sat at p90
// 776ms with a p50 of 137ms while `getMe`, at two waves, only showed the same stall at p99.
// Full derivation: design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md §11.
//
// So each case below pins one wave that was removed, phrased so that restoring the old serial shape
// turns it red — and, deliberately, so that none of them can be satisfied by making a query faster.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tileId, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { CommandService } from '../src/combatMarch/command';
import type { WorldCore } from '../src/core';
import type { MarchDoc, PlayerWorldDoc, TileDoc } from '../src/db';

const W = 's1-rt';
const ACC = 'rt-acct';
const MAP = 200;
const NOW = 1_700_000_000_000;
const FROM = { x: 20, y: 20 };
const TO = { x: 20, y: 22 };

const tid = (x: number, y: number) => tileId(W, x, y);

function tile(x: number, y: number, over: Partial<TileDoc> = {}): TileDoc {
  return { _id: tid(x, y), worldId: W, x, y, type: 'territory', level: 1, garrison: 0, rev: 0, ...over } as unknown as TileDoc;
}

function playerWorld(over: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${ACC}`, worldId: W, accountId: ACC, troops: 100_000, troopCap: 100_000,
    resources: {}, yieldRate: {}, lastTickAt: NOW, mainBaseTile: tid(FROM.x, FROM.y), rev: 0,
    ...over,
  } as unknown as PlayerWorldDoc;
}

/** A team whose army is plain units — the flat-troop path, which is the one that debits the pool. */
function flatTeam() {
  return {
    id: 't1', name: 'T', army: [{ col: 0, row: 0, unitType: 'sword', initialHp: 700 }],
  } as unknown as NonNullable<PlayerWorldDoc['teams']>[number];
}

function cursor<T>(docs: T[], wrap?: (fn: () => Promise<T[]>) => () => Promise<T[]>) {
  const toArray = async () => docs;
  const c = { project: () => c, sort: () => c, toArray: wrap ? wrap(toArray) : toArray };
  return c;
}

interface Opts {
  pw?: PlayerWorldDoc;
  tiles?: TileDoc[];
  /** Replaces the default `visionObservers` (which resolves immediately with nobody). */
  visionObservers?: () => Promise<string[]>;
}

/**
 * Records each instrumented call as a [start, end) interval on a monotonic EVENT counter, so a case can
 * ask whether two named operations were in flight at the same time.
 *
 * Event counters rather than a clock on purpose: no duration to be flaky about, and no way for a fast
 * query to look "concurrent". And per-operation rather than a global peak — a global peak is satisfied
 * by ANY parallel batch anywhere in the call, which is exactly how the first version of this file
 * survived a mutation that made the opening reads serial again (the pathfinder's own batch kept it green).
 */
function instrument() {
  let seq = 0;
  const spans: { label: string; start: number; end: number }[] = [];
  const wrap = <A extends unknown[], R>(label: string, fn: (...a: A) => Promise<R>) =>
    vi.fn(async (...a: A) => {
      const start = ++seq;
      try {
        return await fn(...a);
      } finally {
        spans.push({ label, start, end: ++seq });
      }
    });
  /** True if some call labelled `a` and some call labelled `b` were in flight at the same time. */
  const overlapped = (a: string, b: string): boolean =>
    spans.some((x) => x.label === a &&
      spans.some((y) => y.label === b && x.start < y.end && y.start < x.end));
  return { wrap, overlapped, labels: () => spans.map((x) => x.label) };
}

function fakeCore(o: Opts = {}) {
  const tilesById = new Map((o.tiles ?? []).map((t) => [t._id, t]));
  const probe = instrument();
  const cols = {
    playerWorld: {
      findOne: probe.wrap('pw.findOne', async () => o.pw ?? playerWorld()),
      updateOne: probe.wrap('pw.updateOne', async () => ({ matchedCount: 1 })),
      find: vi.fn(() => cursor([], (fn) => probe.wrap('pw.find', fn))),
    },
    tiles: {
      findOne: probe.wrap('tiles.findOne', async (f: { _id: string }) => tilesById.get(f._id) ?? null),
      find: vi.fn((f?: { _id?: { $in?: string[] } }) =>
        cursor(
          (f?._id?.$in ?? []).map((id) => tilesById.get(id)).filter((t): t is TileDoc => !!t),
          (fn) => probe.wrap(f?._id?.$in ? 'endpointTiles' : 'tiles.scan', fn),
        )),
    },
    marches: {
      findOne: probe.wrap('teamBusy.march', async () => null),
      find: vi.fn(() => cursor([] as MarchDoc[], (fn) => probe.wrap('marches.find', fn))),
      insertOne: probe.wrap('marches.insertOne', async () => ({})),
      deleteOne: probe.wrap('marches.deleteOne', async () => ({ deletedCount: 1 })),
    },
    occupations: { findOne: probe.wrap('teamBusy.hold', async () => null) },
    siegeDamage: { findOne: probe.wrap('teamBusy.siege', async () => null) },
    stationed: {
      findOne: probe.wrap('teamBusy.stationed', async () => null),
      findOneAndDelete: probe.wrap('stationed.claim', async () => null),
      insertOne: probe.wrap('stationed.insertOne', async () => ({})),
    },
  };
  const core = {
    deps: { cols, mapW: MAP, mapH: MAP, now: () => NOW },
    marchSeq: 0,
    inBounds: (x: number, y: number) => x >= 0 && y >= 0 && x < MAP && y < MAP,
    coordX: (t: string) => Number(t.split(':')[1]),
    coordY: (t: string) => Number(t.split(':')[2]),
    marchView: (m: MarchDoc) => ({ id: m._id, kind: m.kind, arriveAt: m.arriveAt }),
    pushMarch: vi.fn(async () => undefined),
    visionObservers: vi.fn(o.visionObservers ?? (async () => [] as string[])),
    computeVisionSources: vi.fn(async () => []),
    familyMemberIds: vi.fn(async () => new Set<string>([ACC])),
    friendlyAccountIds: vi.fn(async () => new Set<string>()),
    isConnectedToSectTerritory: vi.fn(async () => true),
    targetFootprintCells: (_t: unknown, x: number, y: number) => [{ x, y }],
    // Deliberately async: if it ever became a serial await again, `peakInFlight` would notice.
    sectPayoff: probe.wrap('sectPayoff', async () => ({ marchMult: 1 })),
    clearOccupancy: vi.fn(async () => undefined),
    setOccupancy: vi.fn(async () => undefined),
    meta: {
      available: true,
      getSaveFields: vi.fn(async () => ({ cardInv: {}, equipmentInv: {} })),
      getProfile: vi.fn(async () => null),
    },
    gateway: { push: vi.fn(async () => undefined) },
    socialsvc: { getFamiliesByIds: vi.fn(async () => []) },
    settle: () => ({}),
    getMe: vi.fn(async () => ({ accountId: ACC })),
  };
  return { svc: new CommandService(core as unknown as WorldCore), cols, core, probe };
}

const OWNED = [tile(FROM.x, FROM.y, { ownerId: ACC }), tile(TO.x, TO.y, { ownerId: ACC })];
/** Own origin, free target — the shape an `occupy` needs, which is the kind that commands a team. */
const OCCUPIABLE = [tile(FROM.x, FROM.y, { ownerId: ACC })];

/** Calls to `tiles.find` that are the endpoint batch, as opposed to the pathfinder's obstacle scans. */
function endpointFindCalls(cols: { tiles: { find: unknown } }): unknown[][] {
  const calls = (cols.tiles.find as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter((c) => !!(c[0] as { _id?: { $in?: string[] } } | undefined)?._id?.$in);
}

/** A team dispatch context: flat team, full stamina, own origin, free target. */
function teamedCore() {
  return fakeCore({
    tiles: OCCUPIABLE,
    pw: playerWorld({
      teams: [flatTeam()],
      teamState: { t1: { stamina: SLG_TEAM_STAMINA_MAX, staminaAt: NOW } },
    } as unknown as Partial<PlayerWorldDoc>),
  });
}

let ctx: ReturnType<typeof fakeCore>;

describe('startMarch round-trip shape', () => {
  beforeEach(() => {
    ctx = fakeCore({ tiles: OWNED });
  });

  it('reads both march endpoints in ONE query, not one per end', async () => {
    await ctx.svc.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600);

    // The origin and the target used to be two `findOne`s a wave apart — the second of them buried
    // inside validateMarchTarget, which is why it was easy to miss that they are independent reads.
    // Not one `findOne` anywhere on the dispatch: the two endpoint reads became one batched query, and
    // the pathfinder's own re-read of the destination is gone too (it is handed the document instead).
    expect(ctx.cols.tiles.findOne).not.toHaveBeenCalled();
    expect(endpointFindCalls(ctx.cols)).toHaveLength(1);
    expect(endpointFindCalls(ctx.cols)[0]![0]).toEqual({ _id: { $in: [tid(FROM.x, FROM.y), tid(TO.x, TO.y)] } });
  });

  it('issues the opening reads together rather than one after the other', async () => {
    // A TEAM dispatch, because team resolution is one of the three answers being overlapped — a
    // flat-pool march resolves no team and would leave nothing to overlap with.
    const teamed = teamedCore();
    await teamed.svc.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 600, 't1');
    ctx = teamed;

    // Team resolution, both endpoint tiles and the sect payoff are three independent answers, and the
    // assertion names them: each pair must have been in flight together. Overlap cannot be satisfied by
    // a faster query — serial awaits never overlap however quick each one is — and naming the pair keeps
    // some OTHER parallel batch later in the call (the pathfinder has one) from standing in for this one.
    expect(ctx.probe.overlapped('endpointTiles', 'sectPayoff')).toBe(true);
    expect(ctx.probe.overlapped('endpointTiles', 'teamBusy.march')).toBe(true);
  });

  it('still refuses a march from a tile the caller does not own', async () => {
    // The batched read is speculative — taken from the coordinates the CALLER asked to depart from.
    // The check it feeds must be exactly as strict as when it had its own round trip.
    const foreign = fakeCore({ tiles: [tile(FROM.x, FROM.y, { ownerId: 'someone-else' }), OWNED[1]!] });
    await expect(foreign.svc.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600))
      .rejects.toMatchObject({ name: 'SlgError', code: 'TILE_NOT_OWNED' });
    expect(foreign.cols.marches.insertOne).not.toHaveBeenCalled();
  });

  it('does not hold the caller for the reverse-vision fan-out', async () => {
    // A push to OTHER players, issued after the dispatch has already committed — nothing it finds can
    // change the answer being returned. Pending forever is the only formulation of "not awaited" that
    // cannot pass by accident: a timing-based version would be green whenever the query happened to be
    // fast, which is precisely the case this needs to fail on.
    let release: (v: string[]) => void = () => undefined;
    const hung = fakeCore({
      tiles: OWNED,
      visionObservers: () => new Promise<string[]>((resolve) => { release = resolve; }),
    });

    const view = await hung.svc.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'reinforce', 600);

    expect(view).toBeTruthy();
    expect(hung.core.visionObservers).toHaveBeenCalledTimes(1); // issued, just not waited on
    release([]);
  });

  it('spends one playerWorld write on a flat-troop team dispatch, charging stamina in it', async () => {
    const teamed = teamedCore();

    await teamed.svc.startMarch(W, ACC, FROM.x, FROM.y, TO.x, TO.y, 'occupy', 600, 't1');

    expect(teamed.cols.playerWorld.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = (teamed.cols.playerWorld.updateOne as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(update).toHaveProperty('$inc');
    expect((update as { $set: Record<string, unknown> }).$set).toHaveProperty('teamState.t1.stamina');
  });
});
