// worldsvc alliance territory marking end-to-end (G5 remaining items, §8.2 / §18.1 V5): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Territory belonging to members of allied sects (sect.allySectIds): **vision is not shared** — only tiles within line-of-sight are marked allySect=true (client renders with yellow outline).
//   Lookup chain: accountId → playerWorld.familyId → socialsvc family.sectId → sect.allySectIds → allied-sect member families (socialsvc) → members.
// Family identity/roster now lives in socialsvc (P4 follow-up, see db.ts note above SectDoc) — this suite fakes
// WorldSocialsvcClient in-process instead of inserting worldsvc-local family fixtures; per-world membership is carried by PlayerWorldDoc.familyId (mirrored on joinWorld).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_MAP_W, SLG_MAP_H, familyProsperity, type FamilyRole } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

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

/** In-process fake of socialsvc's family store (P4 follow-up: family identity/roster/sectId mirror now live there, not in worldsvc). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

  /** Register a family with an explicit id + sectId (alliance tests wire sects directly, so the id is supplied). */
  addFamily(familyId: string, leaderId: string, name: string, tag: string, sectId?: string): string {
    this.families.set(familyId, {
      familyId, name, tag: tag.toUpperCase(), leaderId, memberCount: 1,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0, ...(sectId ? { sectId } : {}),
    });
    this.memberRole.set(leaderId, { familyId, role: 'leader' });
    return familyId;
  }

  addMember(accountId: string, familyId: string): void {
    this.memberRole.set(accountId, { familyId, role: 'member' });
    const f = this.families.get(familyId);
    if (f) f.memberCount += 1;
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    return this.memberRole.get(accountId)?.familyId ?? null;
  }

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    const m = this.memberRole.get(accountId);
    if (!m) return null;
    const f = this.families.get(m.familyId);
    if (!f) return null;
    return { familyId: m.familyId, role: m.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id)).filter((f): f is FamilySummary & { activity: number } => !!f)
      .map((f) => ({ ...f }));
  }

  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }

  async setSect(familyId: string, sid: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) f.sectId = sid;
    else delete f.sectId;
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    const f = this.families.get(familyId);
    if (f) f.activity += delta;
  }

  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    const f = this.families.get(familyId);
    if (!f) return 0;
    f.prosperity = familyProsperity(territoryCount, f.memberCount, f.activity);
    f.prosperityUpdatedAt = Date.now();
    f.territoryCount = territoryCount;
    return f.prosperity;
  }

  async resetSlgState(familyId: string): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    f.territoryCount = 0;
    f.prosperity = 0;
    f.activity = 0;
    delete f.sectId;
  }

  async push(_channel: SocialsvcChannel, _event: string, _payload: unknown, _targets?: string[]): Promise<void> {
    /* not exercised here */
  }
}

describe.skipIf(!mongo)('worldsvc alliance territory marking e2e (G5 / §8.2 V5)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;

  // Sect/family ids (chain: a∈famA∈sectA, sectA allied with sectB; ally1/ally2∈famB∈sectB; enemy∈famE∈sectC with no alliance).
  const sectA = `s:${W}:AAA`;
  const sectB = `s:${W}:BBB`;
  const sectC = `s:${W}:CCC`;
  const famA = `f:${W}:A`;
  const famB = `f:${W}:B`;
  const famE = `f:${W}:E`;

  // ADR-025: capitals are a 3×3 footprint, so anchors must be ≥3 apart (Chebyshev). These three sit within
  // a's base vision radius (VISION_BASE_RADIUS=5, viewport centred at 6,6) yet do not overlap each other.
  const A_POS = { x: 5, y: 5 };
  const ALLY_POS = { x: 9, y: 9 };
  const ENEMY_POS = { x: 5, y: 9 };

  /** Registers families in socialsvc + their sect membership; sects themselves stay in the worldsvc `sects` collection (allySectMemberIds reads them directly). */
  async function setupAlliance(): Promise<void> {
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addFamily(famB, 'ally1', 'B', 'B', sectB);
    socialsvc.addMember('ally2', famB);
    socialsvc.addFamily(famE, 'enemy', 'E', 'E', sectC);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 1, allySectIds: [sectB], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'ally1', memberFamilyCount: 1, allySectIds: [sectA], prosperity: 0, rev: 1 },
      { _id: sectC, worldId: W, name: 'C', tag: 'CCC', leaderFamilyId: famE, leaderId: 'enemy', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
    ]);
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({ cols: m.collections, redis: null, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('allied sect territory within vision is marked allySect (not ally / not mine), enemy/family tiles are not marked', async () => {
    // Register family membership first so joinWorld mirrors familyId into each PlayerWorldDoc.
    await setupAlliance();
    await svc.joinWorld(W, 'a', A_POS.x, A_POS.y);
    await svc.joinWorld(W, 'ally1', ALLY_POS.x, ALLY_POS.y); // allied-sect member, within a's base vision radius
    await svc.joinWorld(W, 'enemy', ENEMY_POS.x, ENEMY_POS.y); // non-allied, also within vision

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const allyTile = view.tiles.find((t) => t.x === ALLY_POS.x && t.y === ALLY_POS.y)!;
    expect(allyTile).toMatchObject({ type: 'base', occupied: true, visible: true, allySect: true });
    expect(allyTile.mine).toBeUndefined();
    expect(allyTile.ally).toBeUndefined(); // cross-sect alliance — not the same family

    const enemyTile = view.tiles.find((t) => t.x === ENEMY_POS.x && t.y === ENEMY_POS.y)!;
    expect(enemyTile).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(enemyTile.allySect).toBeUndefined(); // not an allied sect → not marked
    expect(enemyTile.ally).toBeUndefined();
  });

  it('alliance does not share vision: distant allied territory remains fogged (visible:false, no allySect mark)', async () => {
    await setupAlliance();
    await svc.joinWorld(W, 'a', A_POS.x, A_POS.y);
    await svc.joinWorld(W, 'ally2', 250, 250); // allied member but far beyond a's vision

    const view = await svc.getMap(W, 'a', 250, 250, 2);
    const far = view.tiles.find((t) => t.x === 250 && t.y === 250)!;
    expect(far.visible).toBe(false);          // alliance does not share vision → not visible
    expect(far.allySect).toBeUndefined();     // nothing in the dynamic layer (including alliance marks) is leaked outside vision
    expect(far.occupied).toBeUndefined();
  });

  it('no sect / sect with no alliance: visible tiles of others are not marked allySect', async () => {
    await setupAlliance();
    await svc.joinWorld(W, 'a', A_POS.x, A_POS.y);
    await svc.joinWorld(W, 'ally1', ALLY_POS.x, ALLY_POS.y);
    // Remove the alliance of a's sect → ally1's territory is visible but no longer marked.
    await m.collections.sects.updateOne({ _id: sectA }, { $set: { allySectIds: [] } });

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const tile = view.tiles.find((t) => t.x === ALLY_POS.x && t.y === ALLY_POS.y)!;
    expect(tile.visible).toBe(true);
    expect(tile.occupied).toBe(true);
    expect(tile.allySect).toBeUndefined();
  });
});
