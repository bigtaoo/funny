// worldsvc alliance attack constraint end-to-end (R-3, SLG_DESIGN §8.2 / §18.7): real Mongo.
//   §8.2 "盟友间禁止进攻/夺地" — startMarch's attack branch must reject sieging a *friendly* tile.
//   "Friendly" spans three tiers, all blocked with ALLY_TILE: own family (≤30) + own sect (all its families) + allied sects (sect.allySectIds).
//   The friendly check sits BEFORE the protection check in startMarch, so a freshly-joined (protected) base yields:
//     - allied/family/same-sect base → ALLY_TILE (friendly gate fires first)
//     - non-allied enemy base        → PROTECTED (friendly gate passes; protection stops it) → proves the enemy got past the gate
//   Family identity/roster lives in socialsvc (P4); this suite fakes WorldSocialsvcClient in-process (per alliance-mark.e2e).
// Requires a real rs0 Mongo (globalSetup spins one up via mongodb-memory-server unless NW_MONGO_URI is external).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
  baseFootprintInBounds,
  baseFootprintCells,
  familyProsperity,
  type FamilyRole,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_allyatk_test';
const W = 's1-allyatk';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.alliance-attack.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Spiral-search for a spawnable 3×3 base anchor near (sx,sy): whole footprint in-bounds + free of center/obstacle/gate/stronghold (mirrors joinWorld's footprintFree). */
function findBaseCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'gate' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no spawnable base anchor found');
}

/** In-process fake of socialsvc's family store (family identity/roster/sectId mirror live there, P4). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

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
    const mr = this.memberRole.get(accountId);
    if (!mr) return null;
    const f = this.families.get(mr.familyId);
    if (!f) return null;
    return { familyId: mr.familyId, role: mr.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id))
      .filter((f): f is FamilySummary & { activity: number } => !!f).map((f) => ({ ...f }));
  }

  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }

  async setSect(familyId: string, sid: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) f.sectId = sid; else delete f.sectId;
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    const f = this.families.get(familyId);
    if (f) f.activity += delta;
  }

  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    const f = this.families.get(familyId);
    if (!f) return 0;
    f.prosperity = familyProsperity(territoryCount, f.memberCount, f.activity);
    f.territoryCount = territoryCount;
    return f.prosperity;
  }

  async resetSlgState(familyId: string): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    f.territoryCount = 0; f.prosperity = 0; f.activity = 0; delete f.sectId;
  }

  async push(_channel: SocialsvcChannel, _event: string, _payload: unknown, _targets?: string[]): Promise<void> {
    /* not exercised */
  }
}

describe.skipIf(!mongo)('worldsvc alliance attack constraint e2e (R-3 / §8.2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(_a: string, _msg: SlgPushMsg) { /* captured push not asserted here */ },
  };

  // Chain: a ∈ famA ∈ sectA; famMate ∈ famA (same family); s2 ∈ famA2 ∈ sectA (same sect, different family);
  //        ally1 ∈ famB ∈ sectB (sectA ↔ sectB allied); enemy ∈ famC ∈ sectC (no alliance).
  const sectA = `s:${W}:AAA`, sectB = `s:${W}:BBB`, sectC = `s:${W}:CCC`;
  const famA = `f:${W}:A`, famA2 = `f:${W}:A2`, famB = `f:${W}:B`, famC = `f:${W}:C`;

  // Well-separated spawnable anchors (enemy kept near the attacker so the positive-path case has a short clear route).
  let aPos: { x: number; y: number };
  let enemyPos: { x: number; y: number };
  let allyPos: { x: number; y: number };
  let famPos: { x: number; y: number };
  let sectPos: { x: number; y: number };

  /** Register families + sect membership in the fake socialsvc; sects themselves live in the worldsvc `sects` collection (friendlyAccountIds reads them directly). */
  async function setupAlliance(allied = true): Promise<void> {
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addMember('famMate', famA);
    socialsvc.addFamily(famA2, 's2', 'A2', 'A2', sectA);
    socialsvc.addFamily(famB, 'ally1', 'B', 'B', sectB);
    socialsvc.addFamily(famC, 'enemy', 'C', 'C', sectC);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 2, allySectIds: allied ? [sectB] : [], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'ally1', memberFamilyCount: 1, allySectIds: allied ? [sectA] : [], prosperity: 0, rev: 1 },
      { _id: sectC, worldId: W, name: 'C', tag: 'CCC', leaderFamilyId: famC, leaderId: 'enemy', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
    ]);
  }

  /** Join all five players at their anchors (membership must be registered first so joinWorld mirrors familyId into each PlayerWorldDoc). */
  async function joinAll(): Promise<void> {
    await svc.joinWorld(W, 'a', aPos.x, aPos.y);
    await svc.joinWorld(W, 'famMate', famPos.x, famPos.y);
    await svc.joinWorld(W, 's2', sectPos.x, sectPos.y);
    await svc.joinWorld(W, 'ally1', allyPos.x, allyPos.y);
    await svc.joinWorld(W, 'enemy', enemyPos.x, enemyPos.y);
  }

  /** Run an attack march from a's base to (target) and return the SlgError code, or 'OK' if it started. */
  async function attackCode(target: { x: number; y: number }): Promise<string> {
    try {
      await svc.startMarch(W, 'a', aPos.x, aPos.y, target.x, target.y, 'attack', OCCUPY_MIN_TROOPS);
      return 'OK';
    } catch (e) {
      return (e as { code?: string }).code ?? (e as Error).message;
    }
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    aPos = findBaseCoord(8, 8);
    enemyPos = findBaseCoord(8, 20);
    famPos = findBaseCoord(40, 8);
    sectPos = findBaseCoord(8, 40);
    allyPos = findBaseCoord(40, 40);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('blocks sieging an allied-sect member base (ALLY_TILE)', async () => {
    await setupAlliance(true);
    await joinAll();
    expect(await attackCode(allyPos)).toBe('ALLY_TILE');
  });

  it('blocks sieging a same-family member base (ALLY_TILE)', async () => {
    await setupAlliance(true);
    await joinAll();
    expect(await attackCode(famPos)).toBe('ALLY_TILE');
  });

  it('blocks sieging a same-sect (different family) member base (ALLY_TILE)', async () => {
    await setupAlliance(true);
    await joinAll();
    expect(await attackCode(sectPos)).toBe('ALLY_TILE');
  });

  it('lets an attack on a non-allied enemy pass the friendly gate (protected base → PROTECTED, not ALLY_TILE)', async () => {
    await setupAlliance(true);
    await joinAll();
    // Enemy base is freshly joined → protection shield. The friendly gate is not tripped (different, non-allied sect),
    // so the next guard (protection) fires instead — proving the enemy got past the friendly check.
    expect(await attackCode(enemyPos)).toBe('PROTECTED');
  });

  it('once the enemy protection expires, the attack march actually starts (end-to-end enemy attack works)', async () => {
    await setupAlliance(true);
    await joinAll();
    // Drop the protection shield on the whole enemy footprint, then attack the anchor.
    await m.collections.tiles.updateMany(
      { _id: { $in: baseFootprintCells(enemyPos.x, enemyPos.y).map((c) => tileId(W, c.x, c.y)) } },
      { $unset: { protectedUntil: '' } },
    );
    expect(await attackCode(enemyPos)).toBe('OK');
  });

  it('dissolving the alliance makes the former ally attackable again (no ALLY_TILE)', async () => {
    await setupAlliance(false); // sectA and sectB not allied
    await joinAll();
    // ally1's base is a different, now non-allied sect → friendly gate passes; only its protection stops the attack.
    expect(await attackCode(allyPos)).toBe('PROTECTED');
  });
});
