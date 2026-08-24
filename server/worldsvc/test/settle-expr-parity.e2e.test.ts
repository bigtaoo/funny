// `settle()` vs `settleExpr()` parity (2026-08-24).
//
// core/yield.ts holds one accrual formula in two languages: `settle()` in TypeScript (used by every
// read path — getMe recomputes it on every fetch) and `settleExpr()` as an aggregation expression (used by
// every write path that persists a settle, so the write reads the live document instead of a snapshot).
// Their docstrings say "keep in lockstep" and, until this file existed, nothing enforced it: a change to the
// storage clamp, the `?? 0` handling or the `max(0, dt)` floor could silently apply to reads but not writes,
// or vice versa. That divergence would be near-impossible to spot from either side — the numbers would just
// disagree between what the client is shown and what gets persisted.
//
// This runs the same inputs through both and requires exact equality, over the cases where the two
// implementations could plausibly part ways rather than a single happy path: the clamp, a zero/negative dt,
// an absent field, a balance already over cap, a cabinet-raised cap, and the `scale` argument that only the
// expression form has.
//
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  RESOURCE_TYPES,
  RESOURCE_CAP,
  resourceCapFor,
  type ResourceType,
  type BuildingKey,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldCore } from '../src/core';
import type { PlayerWorldDoc } from '../src/db';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_settle_parity_test';
const W = 's1-settle-parity';
const ACC = 'parity';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.settle-parity.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

type Res = Record<ResourceType, number>;
const res = (fill: number | Partial<Res>): Res => {
  const out = {} as Res;
  for (const rt of RESOURCE_TYPES) out[rt] = typeof fill === 'number' ? fill : (fill[rt] ?? 0);
  return out;
};

describe.skipIf(!mongo)('settle() / settleExpr() parity', () => {
  const m = mongo!;
  let core: WorldCore;

  beforeEach(async () => {
    await m.db.dropDatabase();
    core = new WorldCore({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => 0 });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /**
   * Persist `doc`, run `settleExpr` against it inside an update, and return both what Mongo stored and what
   * the TypeScript `settle()` produced from the same input.
   */
  async function bothWays(doc: Partial<PlayerWorldDoc>, now: number, scale?: number): Promise<{ js: Res; db: Res }> {
    const full = {
      _id: playerWorldId(W, ACC),
      worldId: W,
      accountId: ACC,
      troops: 0,
      troopCap: 1_000,
      resources: res(0),
      yieldRate: res(0),
      lastTickAt: 0,
      rev: 0,
      ...doc,
    } as PlayerWorldDoc;
    await m.collections.playerWorld.replaceOne({ _id: full._id }, full, { upsert: true });

    const settled = core.settle(full, now);
    const js = res(settled);
    // The JS side has no `scale`; apply the same post-step the pre-2026-08-24 callers did, so the two really
    // are being compared on identical intent rather than on two different formulas.
    if (scale !== undefined) for (const rt of RESOURCE_TYPES) js[rt] = Math.floor(js[rt] * scale);

    await m.collections.playerWorld.updateOne({ _id: full._id }, [
      { $set: { resources: core.settleExpr(full.buildings, now, scale) } },
    ]);
    const after = await m.collections.playerWorld.findOne({ _id: full._id });
    return { js, db: res(after!.resources as Res) };
  }

  async function expectParity(doc: Partial<PlayerWorldDoc>, now: number, scale?: number): Promise<Res> {
    const { js, db } = await bothWays(doc, now, scale);
    expect(db).toEqual(js);
    return db;
  }

  const HOUR = 3_600_000;

  it('plain accrual over a whole hour', async () => {
    const out = await expectParity({ resources: res(100), yieldRate: res(60) }, HOUR);
    expect(out.ink).toBe(160);
  });

  it('fractional accrual is floored, not rounded', async () => {
    // 7 units/hour for 10 minutes = 1.1666… — both sides must land on 1, not 2.
    const out = await expectParity({ resources: res(0), yieldRate: res(7) }, HOUR / 6);
    expect(out.ink).toBe(1);
  });

  it('dt of exactly zero accrues nothing', async () => {
    const out = await expectParity({ resources: res(500), yieldRate: res(1_000) }, 0);
    expect(out.ink).toBe(500);
  });

  it('a clock that went backwards is floored at zero dt, never negative accrual', async () => {
    const out = await expectParity({ resources: res(500), yieldRate: res(1_000), lastTickAt: 10 * HOUR }, HOUR);
    expect(out.ink).toBe(500);
  });

  it('accrual is clamped at the storage cap', async () => {
    const out = await expectParity({ resources: res(0), yieldRate: res(RESOURCE_CAP * 10) }, HOUR);
    expect(out.ink).toBe(RESOURCE_CAP);
  });

  it('a balance already above the cap is clamped DOWN to it (both sides, same direction)', async () => {
    // This is the case the storage clamp makes lossy: a doc seeded above cap (fund() in tests, a legacy doc,
    // a cap lowered by balance) settles down to the cap rather than staying put.
    const out = await expectParity({ resources: res(RESOURCE_CAP + 50_000), yieldRate: res(0) }, HOUR);
    expect(out.ink).toBe(RESOURCE_CAP);
  });

  it('a cabinet-raised cap lifts the clamp identically on both sides', async () => {
    const buildings = { cabinet: 3 } as Partial<Record<BuildingKey, number>>;
    const raised = resourceCapFor(buildings);
    expect(raised).toBeGreaterThan(RESOURCE_CAP); // fixture guard: cabinet must actually raise it
    const out = await expectParity({ resources: res(0), yieldRate: res(raised * 10), buildings }, HOUR);
    expect(out.ink).toBe(raised);
  });

  it('missing resources / yieldRate entries are treated as zero, not as errors or nulls', async () => {
    // `?? 0` on the JS side vs `$ifNull` on the expression side — the case where a legacy doc predates a
    // resource type being added.
    const partial = { ink: 10 } as unknown as Res;
    const out = await expectParity({ resources: partial, yieldRate: partial }, HOUR);
    expect(out.ink).toBe(20);
    expect(out.paper).toBe(0);
  });

  it('per-resource yields stay independent (no cross-contamination in the expression form)', async () => {
    const out = await expectParity(
      { resources: res({ ink: 1, paper: 2, graphite: 3, metal: 4, sticker: 5 }), yieldRate: res({ ink: 10, paper: 20, graphite: 0, metal: 0, sticker: 100 }) },
      HOUR,
    );
    expect(out).toEqual({ ink: 11, paper: 22, graphite: 3, metal: 4, sticker: 105 });
  });

  it('scale (applySectLeaderPenalty) matches settle-then-floor-multiply', async () => {
    const out = await expectParity({ resources: res(1_001), yieldRate: res(0) }, HOUR, 0.5);
    expect(out.ink).toBe(500); // floor(1001 × 0.5)
  });

  it('scale composes with the cap: the cap applies first, then the multiplier', async () => {
    const out = await expectParity({ resources: res(RESOURCE_CAP * 5), yieldRate: res(0) }, HOUR, 0.5);
    expect(out.ink).toBe(Math.floor(RESOURCE_CAP * 0.5));
  });

  it('scale of 1 is a no-op, identical to omitting it', async () => {
    const withOne = await expectParity({ resources: res(777), yieldRate: res(60) }, HOUR, 1);
    const without = await expectParity({ resources: res(777), yieldRate: res(60) }, HOUR);
    expect(withOne).toEqual(without);
  });
});
