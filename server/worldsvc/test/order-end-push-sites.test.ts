// Behavioural half of the order-end push audit (the structural half is order-end-push-audit.test.ts).
//
// Two of the four holes the audit turned up live outside OccupationService, so they get their own
// fake-core suites here rather than being bolted onto combatSiege-occupation-encounter-gaps.test.ts
// (which is built entirely around OccupationService's own fake). Same hand-built-fake style, no Mongo.
//
// Both are the reported bug reached by a different door: an order ends server-side, the owner's client
// is never told on the march_update channel (its only order-refresh trigger since comm-audit-2026-07-27
// P1-2), and the team the dead order names stays busy in their team picker until they reload the page.
import { describe, expect, it, vi } from 'vitest';
import { EncounterService } from '../src/combatSiege/encounter';
import { TerritoryService } from '../src/territory';
import { emptyResources } from '../src/core';
import type { WorldCore } from '../src/core';
import type { SiegeHelpersService } from '../src/combatSiege/helpers';
import type { MarchDoc, PlayerWorldDoc, StationedDoc, TileDoc } from '../src/db';

const W = 's1';
const ATK = 'atk-1';
const DEF = 'def-1';
const TILE = `${W}:5:5`;

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${overrides.accountId ?? ATK}`, worldId: W, accountId: ATK,
    troops: 0, troopCap: 999_999, resources: emptyResources(), yieldRate: emptyResources(),
    lastTickAt: 0, rev: 0, buildings: {},
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// encounter.ts — a field encounter destroys a resident STATIONED team (ADR-051 P2b scenario 1).
//
// The branch right below it (resident defender was a MARCH) already pushed a 'recalled' march_update to
// the defender. The stationed branch deleted the doc and said nothing — so the wiped team stayed on the
// defender's map as a ghost sprite and, if it was 驻扎 garrison, permanently busy in their picker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function encounterCore(defStationed: StationedDoc | null) {
  const pushOrderEnded = vi.fn(async () => {});
  const pushMarch = vi.fn(async () => {});
  const stationedDeleteOne = vi.fn(async () => ({}));
  const core = {
    deps: {
      cols: {
        stationed: { findOne: async () => defStationed, deleteOne: stationedDeleteOne, updateOne: vi.fn(async () => ({})) },
        marches: { findOne: async () => null, findOneAndDelete: vi.fn(async () => null), updateOne: vi.fn(async () => ({})) },
        playerWorld: { findOne: async () => pw({ accountId: DEF, _id: `${W}:${DEF}` } as Partial<PlayerWorldDoc>), updateOne: vi.fn(async () => ({})) },
      },
      now: () => 1_000,
    },
    meta: { getSaveFields: vi.fn(async () => null) },
    pushOrderEnded, pushMarch,
    pushSiege: vi.fn(async () => {}),
    bumpFamilyActivity: vi.fn(async () => {}),
    clearOccupancy: vi.fn(async () => {}),
    removeCover: vi.fn(async () => {}),
    marchView: (m: MarchDoc) => m as unknown as never,
  } as unknown as WorldCore;
  return { core, pushOrderEnded, stationedDeleteOne };
}

const stationedDoc = (overrides: Partial<StationedDoc> = {}): StationedDoc => ({
  _id: TILE, worldId: W, ownerId: DEF, tile: TILE, x: 5, y: 5, teamId: 't1',
  army: [], troops: 10, sinceAt: 0, mode: 'idle',
  ...overrides,
} as unknown as StationedDoc);

// Flat armies on both sides with a lopsided troop ratio → shouldUseCheapSiege takes the deterministic
// path, so the marcher always wins without spinning up the real engine (same trick the sibling file's
// header documents).
const marcher = (): MarchDoc => ({
  _id: 'm1', worldId: W, ownerId: ATK, fromTile: `${W}:0:0`, toTile: TILE,
  kind: 'occupy', troops: 100_000, morale: 100, departAt: 0, arriveAt: 0,
  army: [], path: [], stepIndex: 0, nextStepAt: 0, status: 'marching', rev: 0,
} as unknown as MarchDoc);

const occEntry = () => ({ kind: 'stationed' as const, id: TILE, ownerId: DEF, tile: TILE, leaveAt: Number.MAX_SAFE_INTEGER });

const helpers = () => ({ recordSiege: vi.fn(async () => ({ _id: 'siege-1' })) } as unknown as SiegeHelpersService);

describe('EncounterService.resolveFieldEncounter — a destroyed stationed defender is announced to its owner', () => {
  it('marcher wins: the StationedDoc is deleted AND the defender is told on the order channel', async () => {
    const { core, pushOrderEnded, stationedDeleteOne } = encounterCore(stationedDoc());
    const svc = new EncounterService(core, helpers());
    await svc.resolveFieldEncounter(marcher(), pw(), occEntry(), TILE, 1_000);
    expect(stationedDeleteOne).toHaveBeenCalledWith({ _id: TILE });
    expect(pushOrderEnded).toHaveBeenCalledWith(DEF, expect.objectContaining({ tile: TILE, kind: 'move', status: 'recalled' }));
  });

  it('a destroyed GARRISON team is announced too — that is the case that also freezes the picker', async () => {
    const { core, pushOrderEnded } = encounterCore(stationedDoc({ mode: 'garrison' }));
    const svc = new EncounterService(core, helpers());
    await svc.resolveFieldEncounter(marcher(), pw(), occEntry(), TILE, 1_000);
    expect(pushOrderEnded).toHaveBeenCalledWith(DEF, expect.objectContaining({ tile: TILE }));
  });

  it('a defender that SURVIVES is not announced as ended — it is still standing there', async () => {
    const { core, pushOrderEnded } = encounterCore(stationedDoc({ troops: 100_000 }));
    const svc = new EncounterService(core, helpers());
    // Weak marcher: the resident holds, its doc is only updated, and claiming it ended would erase a
    // live team from the defender's map.
    await svc.resolveFieldEncounter({ ...marcher(), troops: 1 } as MarchDoc, pw(), occEntry(), TILE, 1_000);
    expect(pushOrderEnded).not.toHaveBeenCalled();
  });

  it('the resident vanished between the occ read and the doc read → no fight, nothing announced', async () => {
    const { core, pushOrderEnded, stationedDeleteOne } = encounterCore(null);
    const svc = new EncounterService(core, helpers());
    const res = await svc.resolveFieldEncounter(marcher(), pw(), occEntry(), TILE, 1_000);
    expect(res.fought).toBe(false);
    expect(stationedDeleteOne).not.toHaveBeenCalled();
    expect(pushOrderEnded).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// territory.ts — abandonTile frees the team parked on the surrendered tile.
//
// Self-inflicted and single-device, but the client still cannot see it: doAbandon adopts the returned
// `me` and re-reads tiles, never ctx.stationed. Abandon a tile a 驻扎 team stood on and that team was
// busy in your own picker until you reloaded.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function territoryCore(freed: StationedDoc | null, tile: TileDoc | null) {
  const pushOrderEnded = vi.fn(async () => {});
  const core = {
    deps: {
      cols: {
        playerWorld: { findOne: async () => pw(), updateOne: vi.fn(async () => ({})) },
        tiles: { findOne: async () => tile, deleteOne: vi.fn(async () => ({})) },
        stationed: { findOneAndDelete: vi.fn(async () => freed) },
      },
      now: () => 1_000,
    },
    pushOrderEnded,
    clearOccupancy: vi.fn(async () => {}),
    removeCover: vi.fn(async () => {}),
    recomputeYield: vi.fn(async () => emptyResources()),
    settleExpr: () => ({}),
    getMe: vi.fn(async () => ({ joined: true })),
  } as unknown as WorldCore;
  return { core, pushOrderEnded };
}

const ownTile = (overrides: Partial<TileDoc> = {}): TileDoc =>
  ({ _id: TILE, worldId: W, x: 5, y: 5, type: 'territory', level: 1, ownerId: ATK, garrison: 7, rev: 0, ...overrides }) as unknown as TileDoc;

describe('TerritoryService.abandonTile — a freed stationed team is announced to its owner', () => {
  it('abandoning a tile a team stood on announces the freed team', async () => {
    const { core, pushOrderEnded } = territoryCore(stationedDoc({ ownerId: ATK }), ownTile());
    await new TerritoryService(core).abandonTile(W, ATK, 5, 5);
    expect(pushOrderEnded).toHaveBeenCalledWith(ATK, expect.objectContaining({ tile: TILE, kind: 'move', status: 'recalled' }));
  });

  it('abandoning an empty tile announces nothing — there was no order to end', async () => {
    const { core, pushOrderEnded } = territoryCore(null, ownTile());
    await new TerritoryService(core).abandonTile(W, ATK, 5, 5);
    expect(pushOrderEnded).not.toHaveBeenCalled();
  });
});
