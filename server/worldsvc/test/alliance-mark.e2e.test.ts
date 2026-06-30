// worldsvc alliance territory marking end-to-end (G5 remaining items, §8.2 / §18.1 V5): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Territory belonging to members of allied sects (sect.allySectIds): **vision is not shared** — only tiles within line-of-sight are marked allySect=true (client renders with yellow outline).
//   Lookup chain: accountId → familyMembers → family.sectId → sect.allySectIds → allied-sect member families → members.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_allymark_test';
const W = 's1-allymark';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.alliance-mark.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

describe.skipIf(!mongo)('worldsvc alliance territory marking e2e (G5 / §8.2 V5)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  // Sect/family ids (chain: a∈famA∈sectA, sectA allied with sectB; ally1/ally2∈famB∈sectB; enemy∈famE∈sectC with no alliance).
  const sectA = `s:${W}:AAA`;
  const sectB = `s:${W}:BBB`;
  const sectC = `s:${W}:CCC`;
  const famA = `f:${W}:A`;
  const famB = `f:${W}:B`;
  const famE = `f:${W}:E`;

  async function setupAlliance(): Promise<void> {
    await m.collections.families.insertMany([
      { _id: famA, worldId: W, name: 'A', tag: 'A', leaderId: 'a', memberCount: 1, territoryCount: 0, sectId: sectA, rev: 1 },
      { _id: famB, worldId: W, name: 'B', tag: 'B', leaderId: 'ally1', memberCount: 2, territoryCount: 0, sectId: sectB, rev: 1 },
      { _id: famE, worldId: W, name: 'E', tag: 'E', leaderId: 'enemy', memberCount: 1, territoryCount: 0, sectId: sectC, rev: 1 },
    ]);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 1, allySectIds: [sectB], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'ally1', memberFamilyCount: 1, allySectIds: [sectA], prosperity: 0, rev: 1 },
      { _id: sectC, worldId: W, name: 'C', tag: 'CCC', leaderFamilyId: famE, leaderId: 'enemy', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
    ]);
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:a`, worldId: W, accountId: 'a', familyId: famA, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:ally1`, worldId: W, accountId: 'ally1', familyId: famB, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:ally2`, worldId: W, accountId: 'ally2', familyId: famB, role: 'member', joinedAt: nowMs },
      { _id: `${W}:enemy`, worldId: W, accountId: 'enemy', familyId: famE, role: 'leader', joinedAt: nowMs },
    ]);
  }

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

  it('allied sect territory within vision is marked allySect (not ally / not mine), enemy/family tiles are not marked', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally1', 9, 9);  // allied-sect member, within a's base vision radius (Chebyshev 4)
    await svc.joinWorld(W, 'enemy', 8, 8);  // non-allied, also within vision
    await setupAlliance();

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const allyTile = view.tiles.find((t) => t.x === 9 && t.y === 9)!;
    expect(allyTile).toMatchObject({ type: 'base', occupied: true, visible: true, allySect: true });
    expect(allyTile.mine).toBeUndefined();
    expect(allyTile.ally).toBeUndefined(); // cross-sect alliance — not the same family

    const enemyTile = view.tiles.find((t) => t.x === 8 && t.y === 8)!;
    expect(enemyTile).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(enemyTile.allySect).toBeUndefined(); // not an allied sect → not marked
    expect(enemyTile.ally).toBeUndefined();
  });

  it('alliance does not share vision: distant allied territory remains fogged (visible:false, no allySect mark)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally2', 250, 250); // allied member but far beyond a's vision
    await setupAlliance();

    const view = await svc.getMap(W, 'a', 250, 250, 2);
    const far = view.tiles.find((t) => t.x === 250 && t.y === 250)!;
    expect(far.visible).toBe(false);          // alliance does not share vision → not visible
    expect(far.allySect).toBeUndefined();     // nothing in the dynamic layer (including alliance marks) is leaked outside vision
    expect(far.occupied).toBeUndefined();
  });

  it('no sect / sect with no alliance: visible tiles of others are not marked allySect', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally1', 9, 9);
    await setupAlliance();
    // Remove the alliance of a's sect → ally1's territory is visible but no longer marked.
    await m.collections.sects.updateOne({ _id: sectA }, { $set: { allySectIds: [] } });

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const tile = view.tiles.find((t) => t.x === 9 && t.y === 9)!;
    expect(tile.visible).toBe(true);
    expect(tile.occupied).toBe(true);
    expect(tile.allySect).toBeUndefined();
  });
});
