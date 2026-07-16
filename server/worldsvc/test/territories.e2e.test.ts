// worldsvc territory overview list e2e (SLG_DESIGN_LOG.md §26): GET /world/territories backs the client's
// Territory Overview panel — the HUD's territoryCount is only an aggregate, listTerritories returns the
// full rows (x, y, level, garrison) so the panel can offer per-tile jump/abandon actions.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proceduralTile, tileId, SLG_MAP_W, SLG_MAP_H, baseFootprintCells } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_territories_test';
const W = 's1-territories';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.territories.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

const OCCUPIABLE = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';
const BLOCKS_CAPITAL = (t: ReturnType<typeof proceduralTile>) =>
  t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';

function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
  excludeCells: Set<string> = new Set(),
): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (excludeCells.has(`${x}:${y}`)) continue;
        if (predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

function findCapitalSite(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 1 || y < 1 || x >= SLG_MAP_W - 1 || y >= SLG_MAP_H - 1) continue;
        if (Math.abs(x - CENTER_X) <= 1 && Math.abs(y - CENTER_Y) <= 1) continue;
        if (!OCCUPIABLE(proceduralTile(W, x, y))) continue;
        if (baseFootprintCells(x, y).every((c) => !BLOCKS_CAPITAL(proceduralTile(W, c.x, c.y)))) return { x, y };
      }
    }
  }
  throw new Error('no matching capital site found');
}

const HOME = findCapitalSite(5, 5);

describe.skipIf(!mongo)('worldsvc territory overview list e2e (SLG_DESIGN_LOG.md §26)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('not yet joined: rejected with TILE_NOT_OWNED', async () => {
    await expect(svc.listTerritories(W, 'ghost')).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('joined but no territory occupied: returns an empty array (capital footprint excluded)', async () => {
    await svc.joinWorld(W, 'a', HOME.x, HOME.y);
    await expect(svc.listTerritories(W, 'a')).resolves.toEqual([]);
  });

  it('returns every owned territory tile with x/y/level/garrison, excludes the capital footprint', async () => {
    await svc.joinWorld(W, 'a', HOME.x, HOME.y);
    const t1 = findCoord(OCCUPIABLE, HOME.x, HOME.y + 3);
    const t2 = findCoord(OCCUPIABLE, HOME.x, HOME.y - 3, new Set([`${t1.x}:${t1.y}`]));
    await svc.occupyTile(W, 'a', t1.x, t1.y);
    await svc.occupyTile(W, 'a', t2.x, t2.y);

    const list = await svc.listTerritories(W, 'a');
    expect(list).toHaveLength(2);
    const byCoord = new Map(list.map((tv) => [`${tv.x}:${tv.y}`, tv]));
    for (const t of [t1, t2]) {
      const view = byCoord.get(`${t.x}:${t.y}`);
      expect(view).toBeDefined();
      expect(view!.type).toBe('territory');
      expect(typeof view!.level).toBe('number');
      expect(view!.garrison).toBeGreaterThan(0);
      expect(view!.mine).toBe(true);
    }
    // Capital footprint (9 base cells) never appears in this list — relocate handles the capital, not jump/abandon.
    for (const cell of baseFootprintCells(HOME.x, HOME.y)) {
      expect(byCoord.has(`${cell.x}:${cell.y}`)).toBe(false);
    }
  });

  it('another player\'s territory is not returned, only the requester\'s own', async () => {
    await svc.joinWorld(W, 'a', HOME.x, HOME.y);
    const otherHome = findCapitalSite(HOME.x + 40, HOME.y + 40);
    await svc.joinWorld(W, 'b', otherHome.x, otherHome.y);
    const mine = findCoord(OCCUPIABLE, HOME.x, HOME.y + 3);
    const theirs = findCoord(OCCUPIABLE, otherHome.x, otherHome.y + 3);
    await svc.occupyTile(W, 'a', mine.x, mine.y);
    await svc.occupyTile(W, 'b', theirs.x, theirs.y);

    const list = await svc.listTerritories(W, 'a');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ x: mine.x, y: mine.y });
  });

  it('abandoning a tile removes it from the list', async () => {
    await svc.joinWorld(W, 'a', HOME.x, HOME.y);
    const t1 = findCoord(OCCUPIABLE, HOME.x, HOME.y + 3);
    await svc.occupyTile(W, 'a', t1.x, t1.y);
    expect(await svc.listTerritories(W, 'a')).toHaveLength(1);

    await svc.abandonTile(W, 'a', t1.x, t1.y);
    expect(await svc.listTerritories(W, 'a')).toEqual([]);
  });
});
