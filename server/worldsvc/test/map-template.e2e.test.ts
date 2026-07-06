// Map template e2e (SLG_DESIGN §24 Layer A): generate/list/getTiles/saveTilesDiff/activate/delete + clone-on-open.
// Real Mongo (dedicated database); entire suite skipped if Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { proceduralTile } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { MapTemplateService } from '../src/mapTemplateService';
import { startHttpApi } from '../src/httpApi';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_maptemplate_test';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.map-template.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('worldsvc map template e2e (§24)', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let svc: WorldService;
  const headers = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-internal-caller': 'admin' };

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new WorldService({ cols: m.collections, redis: null, mapW: 20, mapH: 20, now: () => Date.now() });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'secret', internalKey: KEY },
      svc,
      {} as never,
      {} as never,
      {} as never,
      new MapTemplateService({ cols: m.collections, now: () => Date.now() }),
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('rejects without X-Internal-Key', async () => {
    const r = await fetch(`${base}/admin/world/map-templates`, { headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
  });

  it('generate writes width*height tiles + returns summary; regenerate replaces (idempotent tile count)', async () => {
    const r1 = await fetch(`${base}/admin/world/map-templates/generate`, {
      method: 'POST', headers, body: JSON.stringify({ templateId: 'tpl-a', width: 10, height: 10 }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; data: { templateId: string; tileCount: number; version: number; active: boolean } };
    expect(b1.data.tileCount).toBe(100);
    expect(b1.data.version).toBe(1);
    expect(b1.data.active).toBe(false);

    const r2 = await fetch(`${base}/admin/world/map-templates/generate`, {
      method: 'POST', headers, body: JSON.stringify({ templateId: 'tpl-a', width: 10, height: 10 }),
    });
    const b2 = (await r2.json()) as { data: { tileCount: number; version: number } };
    expect(b2.data.tileCount).toBe(100); // no duplicate/leftover rows from the first generation
    expect(b2.data.version).toBe(2);
  });

  it('list returns the generated template', async () => {
    const r = await fetch(`${base}/admin/world/map-templates`, { headers });
    const b = (await r.json()) as { data: Array<{ templateId: string }> };
    expect(b.data.map((t) => t.templateId)).toContain('tpl-a');
  });

  it('getTiles bbox returns only the requested viewport', async () => {
    const r = await fetch(`${base}/admin/world/map-templates/tpl-a/tiles?x=0&y=0&w=3&h=3`, { headers });
    const b = (await r.json()) as { data: Array<{ x: number; y: number }> };
    expect(b.data.length).toBe(9);
    expect(b.data.every((t) => t.x < 3 && t.y < 3)).toBe(true);
  });

  it('saveTilesDiff upserts exactly the given tiles, out-of-bounds tile is rejected', async () => {
    const r = await fetch(`${base}/admin/world/map-templates/tpl-a/tiles`, {
      method: 'PUT', headers, body: JSON.stringify({ tiles: [{ x: 0, y: 0, type: 'obstacle', level: 1 }] }),
    });
    expect(r.status).toBe(200);
    const rGet = await fetch(`${base}/admin/world/map-templates/tpl-a/tiles?x=0&y=0&w=1&h=1`, { headers });
    const bGet = (await rGet.json()) as { data: Array<{ type: string }> };
    expect(bGet.data[0]!.type).toBe('obstacle');

    const rBad = await fetch(`${base}/admin/world/map-templates/tpl-a/tiles`, {
      method: 'PUT', headers, body: JSON.stringify({ tiles: [{ x: 999, y: 0, type: 'neutral', level: 1 }] }),
    });
    expect(rBad.status).toBe(400);
  });

  it('activate then delete-guard rejects; deleting a non-active template succeeds', async () => {
    await fetch(`${base}/admin/world/map-templates/generate`, {
      method: 'POST', headers, body: JSON.stringify({ templateId: 'tpl-b', width: 4, height: 4 }),
    });
    const act = await fetch(`${base}/admin/world/map-templates/tpl-a/activate`, { method: 'POST', headers });
    expect(act.status).toBe(200);

    const delActive = await fetch(`${base}/admin/world/map-templates/tpl-a`, { method: 'DELETE', headers });
    expect(delActive.status).toBe(400);

    const delOther = await fetch(`${base}/admin/world/map-templates/tpl-b`, { method: 'DELETE', headers });
    expect(delOther.status).toBe(200);
    const list = (await (await fetch(`${base}/admin/world/map-templates`, { headers })).json()) as { data: Array<{ templateId: string }> };
    expect(list.data.map((t) => t.templateId)).not.toContain('tpl-b');
  });

  it('opening a world clones the active template into mapBaselines (copy, not a live reference)', async () => {
    const openRes = await fetch(`${base}/admin/world/open`, {
      method: 'POST', headers, body: JSON.stringify({ worldId: 's9-tpl', season: 9, shard: 1, capacity: 100 }),
    });
    expect(openRes.status).toBe(200);

    const cloned = await m.collections.mapBaselines.find({ worldId: 's9-tpl' }).toArray();
    expect(cloned.length).toBe(100); // tpl-a is 10x10

    // Editing the template afterwards must not retroactively change the already-cloned world baseline.
    await fetch(`${base}/admin/world/map-templates/tpl-a/tiles`, {
      method: 'PUT', headers, body: JSON.stringify({ tiles: [{ x: 1, y: 1, type: 'gate', level: 9 }] }),
    });
    const stillCloned = await m.collections.mapBaselines.findOne({ _id: 's9-tpl:1:1' });
    expect(stillCloned?.type).not.toBe('gate');
  });

  it('a published template edit reaches the runtime map read via the per-world baseline (§24 read-path)', async () => {
    // tpl-a is the active template (activated earlier). Publish a distinctive edit, then open a fresh world so the
    // clone picks it up, and read the tile back through the runtime getMap/getTile path.
    const wid = 's9-baseline';
    // The edit carries obstacleKind (§24 art-parity): a painted river must round-trip through baseline → getMap.
    await fetch(`${base}/admin/world/map-templates/tpl-a/tiles`, {
      method: 'PUT', headers, body: JSON.stringify({ tiles: [{ x: 2, y: 3, type: 'obstacle', level: 9, obstacleKind: 'river' }] }),
    });
    const openRes = await fetch(`${base}/admin/world/open`, {
      method: 'POST', headers, body: JSON.stringify({ worldId: wid, season: 9, shard: 2, capacity: 100 }),
    });
    expect(openRes.status).toBe(200);

    // The clone carried the edit (incl. obstacleKind) into the world's baseline...
    const baseline = await m.collections.mapBaselines.findOne({ _id: `${wid}:2:3` });
    expect(baseline?.type).toBe('obstacle');
    expect(baseline?.level).toBe(9);
    expect(baseline?.obstacleKind).toBe('river');

    // ...and getMap now surfaces that baseline (not proceduralTile) for the un-owned tile.
    const view = await svc.getMap(wid, 'reader-acct', 2, 3, 2);
    const tile = view.tiles.find((t) => t.x === 2 && t.y === 3)!;
    expect(tile.type).toBe('obstacle');
    expect(tile.level).toBe(9);
    expect(tile.obstacleKind).toBe('river');
    // Single-tile read path resolves the baseline the same way.
    const single = await svc.getTile(wid, 'reader-acct', 2, 3);
    expect(single.type).toBe('obstacle');
    expect(single.level).toBe(9);
    expect(single.obstacleKind).toBe('river');
  });

  it('a world with no baseline rows falls back to proceduralTile (fallback preserved)', async () => {
    // Never opened/cloned → no mapBaselines rows for this worldId → runtime reads fall back to proceduralTile.
    const wid = 'no-baseline-world';
    expect(await m.collections.mapBaselines.countDocuments({ worldId: wid })).toBe(0);

    const view = await svc.getMap(wid, 'reader-acct', 5, 5, 1);
    const tile = view.tiles.find((t) => t.x === 5 && t.y === 5)!;
    const proc = proceduralTile(wid, 5, 5);
    expect(tile.type).toBe(proc.type);
    expect(tile.level).toBe(proc.level);

    const single = await svc.getTile(wid, 'reader-acct', 5, 5);
    expect(single.type).toBe(proc.type);
    expect(single.level).toBe(proc.level);
  });
});
