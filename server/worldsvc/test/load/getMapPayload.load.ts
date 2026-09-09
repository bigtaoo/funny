// `GET /world/map` payload-size measurement — WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §6.7 item 3.
//
// The audit's only number for this was "getMap r=40 → 528KB", taken from an offline micro-benchmark, and
// its egress estimate (21MB/s) multiplied it by a 5s poll that the client no longer has. This measures the
// payload the client actually asks for, and decomposes it, so the fix can be chosen from a breakdown
// instead of from a single total.
//
// It is deterministic and self-contained — its own in-memory replica set, a fixed seed, a fixed tile mix —
// so unlike the order-throughput load test next door (§6.6b: not repeatable against a shared world) two
// runs of this produce the same bytes. That is the whole reason it is worth having: the payload question
// can be closed on a laptop.
//
//   npm run test:load -w @nw/worldsvc -- test/load/getMapPayload.load.ts
//
// Reads nothing from the environment and needs no docker stack. Prints a report; asserts only the
// invariants that would mean the harness itself is broken (non-empty payload, radius clamp honoured).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  tileId,
  type TileType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type TileDoc } from '../../src/db';
import { WorldService } from '../../src/service';
import type { WorldMetaClient, PlayerProfile, SaveFields, SaveField } from '../../src/metaClient';
import type { WorldMapView, WorldMapSparseView, WorldTileView } from '../../src/worldTypes';

const W = 's1-payload';
const NOW = 1_800_000_000_000;

/**
 * Radii the client actually requests, evaluated from `WorldMapRenderer/viewport.ts`'s
 * `ceil(max(spanTx, spanTy)/2) + 4` at each zoom level and layout (see the payload report in
 * WORLDSVC_CONCURRENCY_AUDIT §8 for the table this came from). Zoom 1 is the only one that hits
 * `getMap` at all — zoom 2/3 go to `getMapSparse` — so 14..30 is the real full-map range and 40
 * (the MAP_VIEW_MAX_RADIUS clamp) is included only as the audit's original reference point.
 */
const RADII = [14, 16, 26, 30, 40] as const;

/** Profile lookups: `getMap` batch-resolves a display name for every foreign owner in the viewport. */
class FakeMeta implements WorldMetaClient {
  readonly available = true;
  async grantMaterial(): Promise<void> {}
  async grantTitle(): Promise<void> {}
  async getSaveFields(_a: string, _f?: SaveField[], _c?: readonly string[]): Promise<SaveFields | null> { return null; }
  async getProfile(accountId: string): Promise<PlayerProfile | null> {
    return { publicId: `NW${accountId.slice(-6).toUpperCase()}`, displayName: `玩家${accountId.slice(-4)}` };
  }
  async batchProfiles(accountIds: string[]): Promise<Map<string, PlayerProfile>> {
    const out = new Map<string, PlayerProfile>();
    for (const id of accountIds) out.set(id, (await this.getProfile(id))!);
    return out;
  }
}

const CX = Math.floor(SLG_MAP_W / 2) + 137; // off-centre so the viewport is ordinary land, not the world centre
const CY = Math.floor(SLG_MAP_H / 2) + 91;

/** A territory tile exactly as `occupyTile` writes it (territory.ts), for a synthetic neighbour. */
function territoryDoc(x: number, y: number, ownerId: string, familyId: string): TileDoc {
  const proc = proceduralTile(W, x, y);
  return {
    _id: tileId(W, x, y),
    worldId: W,
    x, y,
    type: 'territory' as TileType,
    level: proc.level,
    ...(proc.resType ? { resType: proc.resType } : {}),
    ownerId,
    familyId,
    garrison: 200,
    garrisonRegenAt: NOW - 60_000,
    hp: 800,
    rev: 0,
  } as TileDoc;
}

/** Bytes a value costs inside a JSON object, including its key and one separator. */
function fieldBytes(key: string, value: unknown): number {
  return Buffer.byteLength(`"${key}":${JSON.stringify(value)},`, 'utf8');
}

interface Breakdown {
  total: number;
  perField: Map<string, { bytes: number; count: number }>;
}

function breakdown(tiles: readonly WorldTileView[]): Breakdown {
  const perField = new Map<string, { bytes: number; count: number }>();
  let total = 0;
  for (const t of tiles) {
    for (const [k, v] of Object.entries(t)) {
      if (v === undefined) continue;
      const b = fieldBytes(k, v);
      total += b;
      const cur = perField.get(k) ?? { bytes: 0, count: 0 };
      cur.bytes += b;
      cur.count += 1;
      perField.set(k, cur);
    }
    total += 2; // the tile object's own braces
  }
  return { total, perField };
}

/**
 * Is this tile byte-for-byte what the client could have produced locally from `proceduralTile`?
 * The client already does exactly this for unoccupied cells at zoom 2/3 (`getMapSparse`'s contract),
 * so this is the size of the "the client already knows this" slice of a zoom-1 payload — the number
 * that decides whether a diff protocol is worth building.
 */
function isClientDerivable(t: WorldTileView): boolean {
  const p = proceduralTile(W, t.x, t.y);
  const expected: WorldTileView = {
    x: t.x, y: t.y, type: p.type, level: p.level,
    ...(p.resType ? { resType: p.resType } : {}),
    ...(p.obstacleKind ? { obstacleKind: p.obstacleKind } : {}),
    visible: true,
  };
  return JSON.stringify(t) === JSON.stringify(expected);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function report(label: string, view: WorldMapView): void {
  const json = JSON.stringify(view);
  const bytes = Buffer.byteLength(json, 'utf8');
  const gz = gzipSync(json).byteLength;
  const b = breakdown(view.tiles);
  const derivable = view.tiles.filter(isClientDerivable);
  const derivableBytes = breakdown(derivable).total;
  const overrides = view.tiles.filter((t) => t.occupied || t.type === 'base' || t.type === 'territory');

  const fields = [...b.perField.entries()].sort((a, c) => c[1].bytes - a[1].bytes);
  console.log(`\n── ${label} ─────────────────────────────────────────`);
  console.log(`  tiles                ${view.tiles.length}  (${view.r * 2 + 1}×${view.r * 2 + 1})`);
  console.log(`  JSON                 ${kb(bytes)}   ${(bytes / view.tiles.length).toFixed(1)} B/tile`);
  console.log(`  gzip                 ${kb(gz)}   (${((gz / bytes) * 100).toFixed(1)}% of JSON, ${(bytes / gz).toFixed(1)}× )`);
  console.log(`  occupied tiles       ${overrides.length}  (${((overrides.length / view.tiles.length) * 100).toFixed(1)}%)`);
  console.log(`  client-derivable     ${derivable.length} tiles / ${kb(derivableBytes)}  = ${((derivableBytes / bytes) * 100).toFixed(1)}% of the payload`);
  console.log(`  field bytes (top):`);
  for (const [k, v] of fields.slice(0, 12)) {
    console.log(`    ${k.padEnd(16)} ${kb(v.bytes).padStart(8)}  ${((v.bytes / bytes) * 100).toFixed(1).padStart(5)}%  on ${v.count} tiles`);
  }
}

function reportSparse(label: string, view: WorldMapSparseView): void {
  const json = JSON.stringify(view);
  const bytes = Buffer.byteLength(json, 'utf8');
  const gz = gzipSync(json).byteLength;
  console.log(`\n── ${label} ─────────────────────────────────────────`);
  console.log(`  tiles                ${view.tiles.length}  (of ${(view.r * 2 + 1) ** 2} cells in the box)`);
  console.log(`  JSON                 ${kb(bytes)}   ${view.tiles.length ? (bytes / view.tiles.length).toFixed(1) : '–'} B/returned tile`);
  console.log(`  gzip                 ${kb(gz)}   (${((gz / bytes) * 100).toFixed(1)}% of JSON)`);
}

let replset: MongoMemoryReplSet;
let mongo: WorldMongo;
let svc: WorldService;

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ binary: { version: '7.0.14' }, replSet: { name: 'rs0', count: 1 } });
  let uri = replset.getUri();
  if (!/[?&]replicaSet=/.test(uri)) uri += (uri.includes('?') ? '&' : '?') + 'replicaSet=rs0';
  mongo = await createWorldMongo(uri, 'nw_world_payload');
  await mongo.ensureIndexes();
  svc = new WorldService({
    cols: mongo.collections,
    redis: null,
    meta: new FakeMeta(),
    mapW: SLG_MAP_W,
    mapH: SLG_MAP_H,
    now: () => NOW,
  });
}, 300_000);

afterAll(async () => {
  await mongo?.db.dropDatabase();
  await mongo?.close();
  await replset?.stop();
});


describe('getMap payload size', () => {
  it('empty world: the terrain floor', async () => {
    for (const r of RADII) {
      const view = await svc.getMap(W, 'viewer', CX, CY, r);
      expect(view.tiles.length).toBe((Math.min(r, 40) * 2 + 1) ** 2);
      report(`r=${r}, EMPTY world (no tile overrides anywhere)`, view);
    }
  }, 300_000);

  it('populated viewport: the requester plus neighbours', async () => {
    // The requester joins (3×3 base footprint, ADR-025) and takes a block of territory; eight
    // neighbours in two families do the same around them. 8 neighbours × (9 base + 30 territory)
    // plus the requester's own is a *busy* zoom-1 viewport, not an average one.
    await svc.joinWorld(W, 'viewer', CX, CY);
    let seeded = 0;
    const docs: TileDoc[] = [];
    const dxs = [-24, -12, 0, 12, 24, -18, 6, 18];
    const dys = [-18, 18, -24, 24, -6, 6, -12, 12];
    for (let i = 0; i < dxs.length; i++) {
      const owner = `neighbour-${String(i).padStart(4, '0')}`;
      const family = `fam-${i % 2}`;
      const ox = CX + dxs[i]!;
      const oy = CY + dys[i]!;
      for (let dy = 0; dy < 6 && seeded < 320; dy++) {
        for (let dx = 0; dx < 5 && seeded < 320; dx++) {
          const x = ox + dx, y = oy + dy;
          const p = proceduralTile(W, x, y);
          if (p.type === 'obstacle' || p.type === 'center' || p.type === 'familyKeep') continue;
          docs.push(territoryDoc(x, y, owner, family));
          seeded++;
        }
      }
    }
    await mongo.collections.tiles.insertMany(docs, { ordered: false });
    console.log(`\n[seeded ${docs.length} foreign territory tiles + the requester's own 3×3 base]`);

    for (const r of RADII) {
      report(`r=${r}, POPULATED viewport (${docs.length} foreign territory tiles)`, await svc.getMap(W, 'viewer', CX, CY, r));
    }

    // What zoom 2 and zoom 3 actually fetch instead, on the same world.
    reportSparse('r=40 sparse lod=mid  (what zoom 2 fetches)', await svc.getMapSparse(W, 'viewer', CX, CY, 40, 'mid'));
    reportSparse('r=40 sparse lod=thin (what zoom 3 fetches)', await svc.getMapSparse(W, 'viewer', CX, CY, 40, 'thin'));
  }, 300_000);
});

/**
 * The cost side of every candidate fix. worldsvc has ONE thread and the whole audit is about not
 * blocking it, so a byte saving that costs synchronous CPU on the response path is not a saving —
 * it is a new head-of-line blocker of exactly the kind §1 is about. Hence both numbers here:
 * how long the compression takes, and whether it runs on the event loop or on libuv's pool.
 */
describe('candidate fixes: bytes saved vs CPU spent', () => {
  const REPS = 20;

  async function timeGzip(json: string, level: number, mode: 'sync' | 'async'): Promise<{ bytes: number; ms: number }> {
    const buf = Buffer.from(json, 'utf8');
    const { gzip, gzipSync } = await import('node:zlib');
    let out = 0;
    const t0 = performance.now();
    for (let i = 0; i < REPS; i++) {
      if (mode === 'sync') {
        out = gzipSync(buf, { level }).byteLength;
      } else {
        out = await new Promise<number>((resolve, reject) =>
          gzip(buf, { level }, (e, b) => (e ? reject(e) : resolve(b.byteLength))));
      }
    }
    return { bytes: out, ms: (performance.now() - t0) / REPS };
  }

  it('prices the levers on the r=40 and r=30 payloads', async () => {
    for (const r of [40, 30] as const) {
      const view = await svc.getMap(W, 'viewer', CX, CY, r);
      const json = JSON.stringify(view);
      const raw = Buffer.byteLength(json, 'utf8');

      // Lever A: transport compression. No protocol change, no client change; the whole point is
      // whether the CPU fits in a budget of 12.5ms/request (§1's "80 orders/s on one core").
      console.log(`\n── r=${r}: transport compression ─────────────────────`);
      for (const level of [1, 6, 9]) {
        const s = await timeGzip(json, level, 'sync');
        const a = await timeGzip(json, level, 'async');
        console.log(`  gzip L${level}  ${kb(s.bytes).padStart(8)}  (${((s.bytes / raw) * 100).toFixed(1)}% of ${kb(raw)})   sync ${s.ms.toFixed(2)}ms  async ${a.ms.toFixed(2)}ms`);
      }

      // Lever B: drop the fields that carry no information.
      const noVisible = view.tiles.map((t) => { const c: Partial<WorldTileView> = { ...t }; delete c.visible; return c; });
      const bNoVisible = Buffer.byteLength(JSON.stringify({ ...view, tiles: noVisible }), 'utf8');

      // Lever C: send only what the client could not have produced from proceduralTile itself
      // (the ceiling of "more sparse" / "incremental diff" — a diff against the client's own
      // procedural generator, which is strictly better than a diff against the last response
      // because it needs no server-side per-session state).
      const nonDerivable = view.tiles.filter((t) => !isClientDerivable(t));
      const bDiff = Buffer.byteLength(JSON.stringify({ ...view, tiles: nonDerivable }), 'utf8');

      console.log(`  baseline JSON        ${kb(raw)}`);
      console.log(`  – drop \`visible\`     ${kb(bNoVisible)}  (−${(((raw - bNoVisible) / raw) * 100).toFixed(1)}%)`);
      console.log(`  – procedural diff    ${kb(bDiff)}  (−${(((raw - bDiff) / raw) * 100).toFixed(1)}%, ${nonDerivable.length}/${view.tiles.length} tiles)`);
      console.log(`  – diff + gzip L6     ${kb((await timeGzip(JSON.stringify({ ...view, tiles: nonDerivable }), 6, 'sync')).bytes)}`);
      expect(raw).toBeGreaterThan(0);
    }
  }, 300_000);
});

/**
 * The measurement that actually decides `sync` vs `async` compression, because wall-clock time does not:
 * both spend the same milliseconds, but `gzipSync` spends them ON the event loop and `zlib.gzip` spends
 * them on libuv's threadpool. §1 of the audit is entirely about not putting CPU on that one thread, so
 * this reads the same instrument the audit's fix is monitored with (`monitorEventLoopDelay`) while a
 * burst of responses is compressed.
 */
describe('compression: where the CPU lands', () => {
  it('event-loop delay under a burst of 20 r=40 responses', async () => {
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const { gzip, gzipSync } = await import('node:zlib');
    const json = JSON.stringify(await svc.getMap(W, 'viewer', CX, CY, 40));
    const buf = Buffer.from(json, 'utf8');

    async function measure(label: string, run: () => Promise<void>): Promise<void> {
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      // A 1ms ticker is what feels the block: every skipped tick is a request that could not be served.
      let ticks = 0;
      const iv = setInterval(() => { ticks++; }, 1);
      const t0 = performance.now();
      await run();
      const wall = performance.now() - t0;
      clearInterval(iv);
      h.disable();
      console.log(`  ${label.padEnd(28)} wall ${wall.toFixed(0)}ms  loopDelay p50 ${(h.percentile(50) / 1e6).toFixed(2)}ms p99 ${(h.percentile(99) / 1e6).toFixed(2)}ms max ${(h.max / 1e6).toFixed(2)}ms  ticks served ${ticks}`);
    }

    console.log('\n── 20 × gzip of a 513KB response ─────────────────────');
    await measure('idle baseline (no gzip)', async () => { await new Promise((r) => setTimeout(r, 150)); });
    await measure('gzipSync L6 ×20', async () => { for (let i = 0; i < 20; i++) gzipSync(buf, { level: 6 }); });
    await measure('zlib.gzip L6 ×20 (parallel)', async () => {
      await Promise.all(Array.from({ length: 20 }, () => new Promise<void>((res, rej) =>
        gzip(buf, { level: 6 }, (e) => (e ? rej(e) : res())))));
    });
    await measure('zlib.gzip L1 ×20 (parallel)', async () => {
      await Promise.all(Array.from({ length: 20 }, () => new Promise<void>((res, rej) =>
        gzip(buf, { level: 1 }, (e) => (e ? rej(e) : res())))));
    });
    expect(json.length).toBeGreaterThan(0);
  }, 300_000);
});

/**
 * Does trimming redundant fields still pay once the transport compresses? `visible` is 18% of the
 * uncompressed payload and is hardcoded `true` on every tile (core/map.ts, since the 2026-07-24 fog-model
 * change made the static layer public), so it looks like the obvious free win — but it is also perfectly
 * repetitive, which is exactly what a compressor eats for nothing. Measured rather than assumed, because
 * the two levers are not additive and the field trim is the one that costs a wire-contract change.
 */
describe('field trim vs compression: are they additive?', () => {
  it('gzip size with and without the always-true `visible`', async () => {
    const { gzipSync } = await import('node:zlib');
    for (const r of [30, 40] as const) {
      const view = await svc.getMap(W, 'viewer', CX, CY, r);
      const withV = JSON.stringify(view);
      const withoutV = JSON.stringify({
        ...view,
        tiles: view.tiles.map((t) => { const c: Partial<WorldTileView> = { ...t }; delete c.visible; return c; }),
      });
      const g1 = gzipSync(withV, { level: 6 }).byteLength;
      const g2 = gzipSync(withoutV, { level: 6 }).byteLength;
      const l1a = gzipSync(withV, { level: 1 }).byteLength;
      const l1b = gzipSync(withoutV, { level: 1 }).byteLength;
      console.log(`\n  r=${r}`);
      console.log(`    raw   ${kb(Buffer.byteLength(withV))} → ${kb(Buffer.byteLength(withoutV))}   (−${(((Buffer.byteLength(withV) - Buffer.byteLength(withoutV)) / Buffer.byteLength(withV)) * 100).toFixed(1)}%)`);
      console.log(`    gzL6  ${kb(g1)} → ${kb(g2)}   (−${(((g1 - g2) / g1) * 100).toFixed(1)}%)`);
      console.log(`    gzL1  ${kb(l1a)} → ${kb(l1b)}   (−${(((l1a - l1b) / l1a) * 100).toFixed(1)}%)`);
      expect(g2).toBeLessThanOrEqual(g1);
    }
  }, 300_000);
});
