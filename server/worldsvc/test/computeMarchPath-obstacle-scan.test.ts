// `computeMarchPath`'s obstacle scan: what ends up in `blockedBaseKeys` (2026-09-17).
//
// The 2026-09-17 round-trip cut (audit doc §11.4) made the four obstacle reads one wave, and the only
// one of them that was not already independent was the enemy-base scan: it used to narrow the query
// with `ownerId: {$nin: [requester, siegeTargetOwner]}`, which is what chained it behind the
// destination-tile read. Unchaining it moved that exclusion from the QUERY to a predicate on the rows.
//
// That is the one semantic rewrite in the whole change, and nothing pinned its result — the behaviour
// suites all stub `tiles.find` to an empty cursor, so the base scan returns nothing and the filter is
// never exercised at all. These cases give the scan real rows and assert the set it produces, which is
// exactly the thing a future "tidy-up" of that filter would break silently.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tileId } from '@nw/shared';
import { computeMarchPath } from '../src/combatShared';
import type { WorldCore } from '../src/core';
import type { PlayerWorldDoc, TileDoc } from '../src/db';

const requests: { passableGateKeys: string[]; blockedBaseKeys: string[] }[] = [];

vi.mock('../src/compute', () => ({
  getComputeBackend: () => ({
    findPath: async (req: { passableGateKeys: string[]; blockedBaseKeys: string[] }) => {
      requests.push({ passableGateKeys: req.passableGateKeys, blockedBaseKeys: req.blockedBaseKeys });
      return [{ x: 10, y: 10 }, { x: 10, y: 11 }];
    },
  }),
}));

const W = 's1-obstacle';
const ME = 'me-acct';
const X_OWNER = 'siege-target-owner';
const Y_OWNER = 'unrelated-enemy';
const MAP = 200;

/** The three base anchors in the leg box: mine, the siege target's, and an unrelated enemy's. */
const MY_BASE = { x: 10, y: 10 };
const X_BASE = { x: 30, y: 30 };
const X_SECOND_BASE = { x: 20, y: 20 }; // same owner as the siege target, but NOT the target tile
const Y_BASE = { x: 25, y: 25 };

function baseTile(at: { x: number; y: number }, ownerId: string): TileDoc {
  return { _id: tileId(W, at.x, at.y), worldId: W, x: at.x, y: at.y, type: 'base', level: 1, ownerId, rev: 0 } as unknown as TileDoc;
}

const ALL_BASES = [
  baseTile(MY_BASE, ME),
  baseTile(X_BASE, X_OWNER),
  baseTile(X_SECOND_BASE, X_OWNER),
  baseTile(Y_BASE, Y_OWNER),
];

function cursor<T>(docs: T[]) {
  const c = { project: () => c, sort: () => c, toArray: async () => docs };
  return c;
}

const pw = {
  _id: `${W}:${ME}`, worldId: W, accountId: ME, mainBaseTile: tileId(W, MY_BASE.x, MY_BASE.y), rev: 0,
} as unknown as PlayerWorldDoc;

function fakeCore() {
  const findOne = vi.fn(async (f: { _id: string }) => ALL_BASES.find((t) => t._id === f._id) ?? null);
  const core = {
    deps: {
      mapW: MAP,
      mapH: MAP,
      now: () => 1_700_000_000_000,
      cols: {
        playerWorld: { findOne: vi.fn(async () => pw) },
        tiles: {
          findOne,
          // Dispatches on which of the three scans this is, and deliberately ignores the x/y ranges:
          // every fixture sits inside the leg box, so range handling is not what these cases are about.
          find: vi.fn((f: Record<string, unknown>) => {
            if (f['structure.kind'] === 'blocker') return cursor([]);
            if (f.type === 'base') {
              // Mirrors the server filter that IS still in the query: never the requester's own bases.
              const ne = (f.ownerId as { $ne?: string } | undefined)?.$ne;
              return cursor(ALL_BASES.filter((t) => t.ownerId !== ne));
            }
            return cursor([]); // gates
          }),
        },
      },
    },
    coordX: (t: string) => Number(t.split(':')[1]),
    coordY: (t: string) => Number(t.split(':')[2]),
  };
  return { core: core as unknown as WorldCore, findOne };
}

let ctx: ReturnType<typeof fakeCore>;

/** `blockedBaseKeys` of the single findPath request the call under test issued. */
const blocked = () => new Set(requests.at(-1)!.blockedBaseKeys);

describe('computeMarchPath obstacle scan', () => {
  beforeEach(() => {
    requests.length = 0;
    ctx = fakeCore();
  });

  it('lets a siege march through the target owner\'s OTHER bases, and only that owner\'s', async () => {
    // Destination is X's base, so X's tiles must not block the route (you may march onto what you are
    // besieging) — including the other base X happens to hold inside the same leg box, which is what
    // the old `$nin` on the query expressed. Y is an unrelated enemy and must still block.
    await computeMarchPath(ctx.core, W, MY_BASE.x, MY_BASE.y, X_BASE.x, X_BASE.y, ME, pw, baseTile(X_BASE, X_OWNER));

    expect(blocked().has(`${X_BASE.x}:${X_BASE.y}`)).toBe(false);
    expect(blocked().has(`${X_SECOND_BASE.x}:${X_SECOND_BASE.y}`)).toBe(false);
    expect(blocked().has(`${Y_BASE.x}:${Y_BASE.y}`)).toBe(true);
  });

  it('blocks every enemy base when the destination is not a base at all', async () => {
    // No siege exemption to grant: an ordinary occupy/move must route around all of them.
    await computeMarchPath(ctx.core, W, MY_BASE.x, MY_BASE.y, 40, 40, ME, pw, null);

    expect(blocked().has(`${X_BASE.x}:${X_BASE.y}`)).toBe(true);
    expect(blocked().has(`${X_SECOND_BASE.x}:${X_SECOND_BASE.y}`)).toBe(true);
    expect(blocked().has(`${Y_BASE.x}:${Y_BASE.y}`)).toBe(true);
  });

  it('never blocks the requester\'s own capital footprint', async () => {
    await computeMarchPath(ctx.core, W, MY_BASE.x, MY_BASE.y, 40, 40, ME, pw, null);

    expect(blocked().has(`${MY_BASE.x}:${MY_BASE.y}`)).toBe(false);
  });

  it('does not re-read the destination tile when the caller hands it over', async () => {
    // The cost half of the same change: startMarch already holds both endpoints, so this read was the
    // second one of the same tile — and it sat in the middle of the chain.
    await computeMarchPath(ctx.core, W, MY_BASE.x, MY_BASE.y, X_BASE.x, X_BASE.y, ME, pw, baseTile(X_BASE, X_OWNER));

    expect(ctx.findOne).not.toHaveBeenCalled();
  });

  it('still reads the destination itself when no caller supplies it', async () => {
    // `undefined` means "read it", and the siege exemption must come out the same way it does above —
    // otherwise the other callers of this function (return marches, stationed re-dispatch) would quietly
    // start routing around a base they are allowed to land on.
    await computeMarchPath(ctx.core, W, MY_BASE.x, MY_BASE.y, X_BASE.x, X_BASE.y, ME, pw, undefined);

    expect(ctx.findOne).toHaveBeenCalledTimes(1);
    expect(blocked().has(`${X_SECOND_BASE.x}:${X_SECOND_BASE.y}`)).toBe(false);
  });
});
