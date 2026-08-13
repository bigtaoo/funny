// worldsvc march/stationed query-optimization regression (2026-07-29 audit item #2): locks in the two changes
// made to computeMarchPath / getMarches / getStationed:
//   ① computeMarchPath's three previously-unindexed `tiles` scans (crossings / enemy-blocked bases / player
//      blockers) now hit `{worldId,type}` / sparse `{worldId,'structure.kind'}` indexes.
//   ② getMarches' enemy-march branch and getStationed's enemy-team branch now push a viewer territory/vision
//      bounding-box filter into Mongo (MarchDoc.minX/maxX/minY/maxY, StationedDoc.x/y) before the exact
//      per-position isInVision check, instead of pulling every in-transit march / stationed team in the world.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_march_query_opt_test';
const W = 's1-marchqopt';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.march-query-opt.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}
const NEUTRAL = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

/** ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` before marching there. */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

describe.skipIf(!mongo)('worldsvc march/stationed query-optimization e2e (2026-07-29)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── ① computeMarchPath index coverage ────────────────────────────────────────────────────────────────

  it('tiles {worldId,type} index serves the crossing (bridge/plankway) scan, not a COLLSCAN', async () => {
    const explain = await m.collections.tiles
      .find({ worldId: W, type: { $in: ['bridge', 'plankway'] } })
      .explain('executionStats');
    const stats = (explain as { executionStats?: { totalKeysExamined: number; executionStages?: { stage?: string } } }).executionStats;
    expect(stats).toBeDefined();
    const stage = JSON.stringify(explain);
    expect(stage).not.toContain('"stage":"COLLSCAN"');
  });

  it('tiles {worldId,type} index serves the enemy-blocked-base scan, not a COLLSCAN', async () => {
    const explain = await m.collections.tiles
      .find({ worldId: W, type: 'base', ownerId: { $nin: ['someone'] } })
      .explain('executionStats');
    expect(JSON.stringify(explain)).not.toContain('"stage":"COLLSCAN"');
  });

  it('tiles sparse {worldId,structure.kind} index serves the blocker scan, not a COLLSCAN', async () => {
    const explain = await m.collections.tiles
      .find({ worldId: W, 'structure.kind': 'blocker' })
      .explain('executionStats');
    expect(JSON.stringify(explain)).not.toContain('"stage":"COLLSCAN"');
  });

  // ── ② getMarches / getStationed bounding-box pushdown ────────────────────────────────────────────────

  it('marches bbox compound index serves the enemy-march query shape, not a COLLSCAN', async () => {
    const explain = await m.collections.marches
      .find({ worldId: W, status: 'marching', minX: { $lte: 100 }, maxX: { $gte: 0 }, minY: { $lte: 100 }, maxY: { $gte: 0 } })
      .explain('executionStats');
    expect(JSON.stringify(explain)).not.toContain('"stage":"COLLSCAN"');
  });

  it('stationed {worldId,x,y} index serves the enemy-team query shape, not a COLLSCAN', async () => {
    const explain = await m.collections.stationed
      .find({ worldId: W, x: { $gte: 0, $lte: 100 }, y: { $gte: 0, $lte: 100 } })
      .explain('executionStats');
    expect(JSON.stringify(explain)).not.toContain('"stage":"COLLSCAN"');
  });

  it('startMarch writes minX/maxX/minY/maxY matching the leg endpoints', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const dst = findCoord(NEUTRAL, 5, 40);
    await connect(svc, 'a', dst);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', OCCUPY_MIN_TROOPS);
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    expect(doc).toBeTruthy();
    expect(doc!.minX).toBe(Math.min(5, dst.x));
    expect(doc!.maxX).toBe(Math.max(5, dst.x));
    expect(doc!.minY).toBe(Math.min(5, dst.y));
    expect(doc!.maxY).toBe(Math.max(5, dst.y));
  });

  it('getMarches: a march far outside the viewer bbox is excluded; one within it is included (bbox pushdown matches old full-scan+filter result)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 8, 8); // within a's base vision (chebyshev 3 ≤ 5)
    await svc.joinWorld(W, 'far', 400, 400); // outside a's vision entirely

    const eDst = findCoord(NEUTRAL, 8, 12);
    await connect(svc, 'e', eDst);
    await svc.startMarch(W, 'e', 8, 8, eDst.x, eDst.y, 'occupy', OCCUPY_MIN_TROOPS);
    const fDst = findCoord(NEUTRAL, 400, 405);
    await connect(svc, 'far', fDst);
    await svc.startMarch(W, 'far', 400, 400, fDst.x, fDst.y, 'occupy', OCCUPY_MIN_TROOPS);

    const marches = await svc.getMarches(W, 'a');
    const enemy = marches.filter((mv) => mv.mine === false);
    expect(enemy).toHaveLength(1);
    expect(enemy[0]!.fromTile).toBe(tileId(W, 8, 8));
  });

  it('a pre-migration march doc (missing minX/maxX/minY/maxY) is invisible to enemy getMarches until recalled, then self-heals', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 8, 8); // within a's vision
    const eDst = findCoord(NEUTRAL, 8, 12);
    await connect(svc, 'e', eDst);
    const mv = await svc.startMarch(W, 'e', 8, 8, eDst.x, eDst.y, 'occupy', OCCUPY_MIN_TROOPS);

    // Simulate a doc created by the pre-2026-07-29 binary: strip the bbox fields the migration would backfill.
    await m.collections.marches.updateOne({ _id: mv.marchId }, { $unset: { minX: '', maxX: '', minY: '', maxY: '' } });

    // Bbox-filtered query no longer matches this doc → temporarily invisible (documented, self-healing gap;
    // see migrateMarchBbox.ts header). Correctness is preserved (no crash, no wrong data) — just an
    // observability gap for the remainder of this leg's natural lifetime.
    const before = await svc.getMarches(W, 'a');
    expect(before.filter((v) => v.mine === false)).toHaveLength(0);

    // recallMarch unconditionally recomputes the box on the outbound→return flip → self-heals immediately.
    await svc.recallMarch(W, 'e', mv.marchId);
    const after = await svc.getMarches(W, 'a');
    const enemy = after.filter((v) => v.mine === false);
    expect(enemy).toHaveLength(1);
    expect(enemy[0]!.kind).toBe('return');
    const healed = await m.collections.marches.findOne({ _id: mv.marchId });
    expect(healed!.minX).toBeDefined();
    expect(healed!.maxX).toBeDefined();
    expect(healed!.minY).toBeDefined();
    expect(healed!.maxY).toBeDefined();
  });

  it('getStationed: enemy team far outside the viewer bbox is excluded; one within it is included', async () => {
    // a's base at (5,5): home-city vision radius 5 covers [0..10]x[0..10].
    await svc.joinWorld(W, 'a', 5, 5);

    const mk = (ownerId: string, x: number, y: number, teamId: string) => ({
      _id: tileId(W, x, y), worldId: W, ownerId, tile: tileId(W, x, y), x, y, teamId,
      army: [], troops: 400, sinceAt: now(), mode: 'idle' as const,
    });
    await m.collections.stationed.insertOne(mk('e', 8, 8, 't1')); // within a's vision
    await m.collections.stationed.insertOne(mk('far', 400, 400, 't1')); // far outside a's vision

    const stationed = await svc.getStationed(W, 'a');
    const enemy = stationed.filter((s) => s.mine === false);
    expect(enemy).toHaveLength(1);
    expect(enemy[0]!.x).toBe(8);
    expect(enemy[0]!.y).toBe(8);
  });
});
