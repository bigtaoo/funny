// worldsvc map-token family-emblem badge end-to-end (family-emblem-art-prompts.md, 2026-08-14): real
// Mongo. Proves getMarches/getOccupations/getStationed actually splice combatShared.ts's
// resolveOwnerEmblems() result back onto the real response by index — resolveOwnerEmblems itself
// (including the multi-owner index-alignment case) already has full pure-function coverage in
// resolve-owner-emblems.test.ts; this file's unique job is the wiring at each of the three call
// sites, through a REAL playerWorld.familyId mirror stamped by a real joinWorld() (not a stub).
//
// Deliberately own-entries-only (never touches the vision-gated "enemy within vision" branches,
// already covered by vision-push.e2e.test.ts for the unrelated concern of what's visible at all) —
// getMarches/getStationed always include the requester's own entries unconditionally, and
// getOccupations is own-holds-only by design, so this is the natural minimal surface to exercise all
// three splice sites without needing to engineer mutual vision between two bases.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SLG_MAP_W, SLG_MAP_H, tileId, EMBLEM_KEYS, EMBLEM_COLORS, type FamilyRole, type EmblemKey,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_marchemblem_test';
const W = 's1-marchemblem';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.march-emblem-badge.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Minimal in-process fake of socialsvc's family store (same contract as alliance-attack.e2e.test.ts's fixture) — this suite only needs getMember (joinWorld's familyId mirror) + getFamiliesByIds (resolveOwnerEmblems' batch lookup). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

  addFamily(familyId: string, leaderId: string, name: string, tag: string, emblem?: { key: EmblemKey; color: number }): void {
    this.families.set(familyId, {
      familyId, name, tag, leaderId, memberCount: 1, prosperity: 0,
      ...(emblem ? { emblemKey: emblem.key, emblemColor: emblem.color } : {}),
    });
    this.memberRole.set(leaderId, { familyId, role: 'leader' });
  }

  async getFamilyId(accountId: string): Promise<string | null> { return this.memberRole.get(accountId)?.familyId ?? null; }

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    const mr = this.memberRole.get(accountId);
    if (!mr) return null;
    const f = this.families.get(mr.familyId);
    if (!f) return null;
    return { familyId: mr.familyId, role: mr.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id)).filter((f): f is FamilySummary => !!f).map((f) => ({ ...f }));
  }

  async getFamiliesBySect(): Promise<FamilySummary[]> { return []; }
  async setSect(): Promise<void> { /* unused */ }
  async bumpActivity(): Promise<void> { /* unused */ }
  async refreshProsperity(): Promise<number> { return 0; }
  async bumpActivityAndProsperity(): Promise<number> { return 0; }
  async resetSlgState(): Promise<void> { /* unused */ }
  async push(_c: SocialsvcChannel, _e: string, _p: unknown): Promise<void> { /* unused */ }
}

describe.skipIf(!mongo)('worldsvc map-token family-emblem badge e2e', () => {
  const m = mongo!;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;
  let nowMs = 1_000_000;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    socialsvc = new FakeSocialsvc();
    // alice's family HAS a badge; bob's family does NOT; carol has no family at all.
    socialsvc.addFamily('fam:AA', 'alice', 'Alpha', 'AA', { key: EMBLEM_KEYS[6]!, color: EMBLEM_COLORS[5]! });
    socialsvc.addFamily('fam:BB', 'bob', 'Beta', 'BB'); // no emblem chosen
    svc = new WorldService({ cols: m.collections, redis: null, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs });
    // joinWorld stamps playerWorld.familyId from socialsvc.getMember at spawn time — the read-only
    // mirror resolveOwnerEmblems relies on (same one familyMemberIds/allySectMemberIds already use).
    await svc.joinWorld(W, 'alice');
    await svc.joinWorld(W, 'bob');
    await svc.joinWorld(W, 'carol'); // no family registered in the fake at all
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('getMarches: own march carries the owner family\'s emblem; no family or no badge → absent', async () => {
    const t = nowMs;
    await m.collections.marches.insertMany([
      {
        _id: 'march:alice', worldId: W, ownerId: 'alice', fromTile: tileId(W, 0, 0), toTile: tileId(W, 1, 0),
        kind: 'move', troops: 100, departAt: t, arriveAt: t + 10_000, status: 'marching',
        rev: 0,
      },
      {
        _id: 'march:bob', worldId: W, ownerId: 'bob', fromTile: tileId(W, 0, 1), toTile: tileId(W, 1, 1),
        kind: 'move', troops: 100, departAt: t, arriveAt: t + 10_000, status: 'marching',
        rev: 0,
      },
      {
        _id: 'march:carol', worldId: W, ownerId: 'carol', fromTile: tileId(W, 0, 2), toTile: tileId(W, 1, 2),
        kind: 'move', troops: 100, departAt: t, arriveAt: t + 10_000, status: 'marching',
        rev: 0,
      },
    ]);

    const aliceMarches = await svc.getMarches(W, 'alice');
    expect(aliceMarches).toHaveLength(1);
    expect(aliceMarches[0]).toMatchObject({ marchId: 'march:alice', emblemKey: EMBLEM_KEYS[6], emblemColor: EMBLEM_COLORS[5] });

    const bobMarches = await svc.getMarches(W, 'bob');
    expect(bobMarches).toHaveLength(1);
    expect(bobMarches[0]!.emblemKey).toBeUndefined();
    expect(bobMarches[0]!.emblemColor).toBeUndefined();

    const carolMarches = await svc.getMarches(W, 'carol');
    expect(carolMarches).toHaveLength(1);
    expect(carolMarches[0]!.emblemKey).toBeUndefined();
  });

  it('getOccupations: own holds-only list carries the owner family\'s emblem', async () => {
    await m.collections.occupations.insertMany([
      { _id: tileId(W, 5, 5), worldId: W, ownerId: 'alice', tile: tileId(W, 5, 5), x: 5, y: 5, level: 1, garrison: 500, dueAt: nowMs + 60_000 },
      { _id: tileId(W, 6, 6), worldId: W, ownerId: 'bob', tile: tileId(W, 6, 6), x: 6, y: 6, level: 1, garrison: 500, dueAt: nowMs + 60_000 },
    ]);

    const aliceOcc = await svc.getOccupations(W, 'alice');
    expect(aliceOcc).toEqual([expect.objectContaining({ tile: tileId(W, 5, 5), emblemKey: EMBLEM_KEYS[6], emblemColor: EMBLEM_COLORS[5] })]);

    const bobOcc = await svc.getOccupations(W, 'bob');
    expect(bobOcc).toHaveLength(1);
    expect(bobOcc[0]!.emblemKey).toBeUndefined();
  });

  it('getStationed: own stationed teams carry the owner family\'s emblem', async () => {
    await m.collections.stationed.insertMany([
      { _id: tileId(W, 7, 7), worldId: W, ownerId: 'alice', tile: tileId(W, 7, 7), x: 7, y: 7, teamId: 't1', army: [], troops: 300, sinceAt: nowMs },
      { _id: tileId(W, 8, 8), worldId: W, ownerId: 'bob', tile: tileId(W, 8, 8), x: 8, y: 8, teamId: 't1', army: [], troops: 300, sinceAt: nowMs },
    ]);

    const aliceSt = await svc.getStationed(W, 'alice');
    expect(aliceSt).toEqual([expect.objectContaining({ tile: tileId(W, 7, 7), mine: true, emblemKey: EMBLEM_KEYS[6], emblemColor: EMBLEM_COLORS[5] })]);

    const bobSt = await svc.getStationed(W, 'bob');
    expect(bobSt).toHaveLength(1);
    expect(bobSt[0]!.emblemKey).toBeUndefined();
  });

  it('resolveOwnerEmblems degrades gracefully if socialsvc goes down mid-request: list still returns, just without badges', async () => {
    await m.collections.marches.insertOne({
      _id: 'march:alice2', worldId: W, ownerId: 'alice', fromTile: tileId(W, 0, 0), toTile: tileId(W, 1, 0),
      kind: 'move', troops: 100, departAt: nowMs, arriveAt: nowMs + 10_000, status: 'marching', rev: 0,
    });
    const originalGetFamiliesByIds = socialsvc.getFamiliesByIds.bind(socialsvc);
    socialsvc.getFamiliesByIds = async () => { throw new Error('socialsvc down'); };
    const marches = await svc.getMarches(W, 'alice');
    expect(marches).toHaveLength(1); // the march itself still comes back
    expect(marches[0]!.emblemKey).toBeUndefined(); // just no badge this round
    socialsvc.getFamiliesByIds = originalGetFamiliesByIds;
  });
});
