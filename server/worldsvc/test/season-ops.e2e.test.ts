// SLG world season ops e2e (§17.5/§17.6/§17.7/§17.11): real Mongo dedicated database. Entire suite skipped if Mongo is unreachable.
//   • settleSeason: writes seasonResults (idempotent _id) + sends reward mail (materials/skins, center capital ×2, idempotent dispatchKey);
//   • resetSeason: guards (must settle first) + batched archive wipe + family season state zeroed + status→open + engineVersion re-pinned + idempotent resume;
//   • admin /admin/world/* gated by X-Internal-Key (no key / player JWT → rejected; valid key → allowed).
// Family identity/roster now lives in socialsvc (P4 migration) — this suite fakes WorldSocialsvcClient in-process
// (mirroring test/sect.e2e.test.ts) instead of inserting worldsvc-local family fixtures; per-world membership is a
// PlayerWorldDoc.familyId, and season-state reset is asserted via the socialsvc mirror (resetSlgState).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  signToken, familyId, playerWorldId, SLG_MAP_W, SLG_MAP_H,
  SETTLE_REWARDS, CENTER_CAPITAL_IDX, CENTER_CAPITAL_MULT, BP_SETTLE_EXTRA,
  familyProsperity, type FamilyRole,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import { createWorldMongo, type WorldMongo, type NationDoc, type WorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import type { WorldMailClient, WorldMailContent } from '../src/mailClient';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_seasonops_test';
const W = 's5-ops';
const SEASON = 5;
const SECRET = 'test-jwt-secret';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.season-ops.e2e] Mongo unreachable (${URI}) — skipping.`);

/** In-process fake of socialsvc's family store (P4: family identity/roster/sectId mirror live there, not in worldsvc). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number; territoryCount?: number; sectId?: string }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();
  /** familyIds passed to resetSlgState (season-state reset assertion). */
  readonly slgResets: string[] = [];

  addFamily(familyIdArg: string, leaderId: string, name: string, tag: string, activity = 0): string {
    this.families.set(familyIdArg, {
      familyId: familyIdArg, name, tag: tag.toUpperCase(), leaderId, memberCount: 1,
      prosperity: 0, prosperityUpdatedAt: 0, activity,
    });
    this.memberRole.set(leaderId, { familyId: familyIdArg, role: 'leader' });
    return familyIdArg;
  }

  addMember(accountId: string, fid: string): void {
    this.memberRole.set(accountId, { familyId: fid, role: 'member' });
    const f = this.families.get(fid);
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

  async setSect(fid: string, sid: string | null): Promise<void> {
    const f = this.families.get(fid);
    if (!f) return;
    if (sid) f.sectId = sid;
    else delete f.sectId;
  }

  async bumpActivity(fid: string, delta: number): Promise<void> {
    const f = this.families.get(fid);
    if (f) f.activity += delta;
  }

  async refreshProsperity(fid: string, territoryCount: number): Promise<number> {
    const f = this.families.get(fid);
    if (!f) return 0;
    f.prosperity = familyProsperity(territoryCount, f.memberCount, f.activity);
    f.prosperityUpdatedAt = Date.now();
    f.territoryCount = territoryCount;
    return f.prosperity;
  }

  async resetSlgState(fid: string): Promise<void> {
    this.slgResets.push(fid);
    const f = this.families.get(fid);
    if (!f) return;
    f.territoryCount = 0;
    f.prosperity = 0;
    f.activity = 0;
    delete f.sectId;
  }

  async push(_channel: SocialsvcChannel, _event: string, _payload: unknown, _targets?: string[]): Promise<void> {
    /* no-op in these tests */
  }
}

interface MailCall { accountId: string; dispatchKey: string; content: WorldMailContent }

describe.skipIf(!mongo)('worldsvc season ops e2e', () => {
  const m = mongo!;
  const mailCalls: MailCall[] = [];
  const fakeMail: WorldMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) { mailCalls.push({ accountId, dispatchKey, content }); },
  };
  let socialsvc: FakeSocialsvc;
  let svc: WorldService;

  /**
   * Reset data and create one active world with two families holding nations (alice: center capital 9 + corner 0; bob: 1).
   * Family identity/roster lives in socialsvc (P4) — registered on the fake; per-world membership is a PlayerWorldDoc.familyId
   * (which is what settleSeason reward expansion, battle-pass scan, and resetSeason season-state reset all read).
   */
  async function seed(status: WorldDoc['status'] = 'active'): Promise<void> {
    const c = m.collections;
    await Promise.all([
      c.worlds.deleteMany({}), c.nations.deleteMany({}), c.seasonResults.deleteMany({}),
      c.tiles.deleteMany({}), c.marches.deleteMany({}), c.playerWorld.deleteMany({}),
      c.sects.deleteMany({}), c.sectMessages.deleteMany({}),
    ]);
    mailCalls.length = 0;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({
      cols: m.collections, redis: null, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, mail: fakeMail, now: () => 1_700_000_000_000,
    });

    await c.worlds.insertOne({
      _id: W, season: SEASON, shard: 5, status, mapW: SLG_MAP_W, mapH: SLG_MAP_H,
      openAt: 1, capacity: 10000, population: 2, engineVersion: ENGINE_VERSION, rev: 1,
    });

    const famAA = familyId(W, 'AA');
    const famBB = familyId(W, 'BB');
    socialsvc.addFamily(famAA, 'alice', 'FamAA', 'AA', 100);
    socialsvc.addFamily(famBB, 'bob', 'FamBB', 'BB', 100);
    // Per-world membership (PlayerWorldDoc.familyId) — read by reward expansion / BP scan / reset season-state snapshot.
    const pw = (acct: string, fid: string) => ({
      _id: playerWorldId(W, acct), worldId: W, accountId: acct,
      troops: 0, troopCap: 0,
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: 0, familyId: fid, rev: 0,
    });
    await c.playerWorld.insertMany([pw('alice', famAA), pw('bob', famBB)] as never);

    const nation = (idx: number, owner: string, tag: string): NationDoc => ({
      _id: `nation:${W}:${idx}`, worldId: W, capitalIdx: idx, x: idx, y: idx,
      ownerId: owner, familyId: familyId(W, tag), rev: 1,
    });
    await c.nations.insertMany([
      nation(CENTER_CAPITAL_IDX, 'alice', 'AA'), // center capital
      nation(0, 'alice', 'AA'),                  // corner capital (AA holds 2 nations total → champion)
      nation(1, 'bob', 'BB'),                    // BB holds 1 nation → top3
    ]);
  }

  afterAll(async () => {
    await m.db.dropDatabase();
  });

  it('settle: writes seasonResults (idempotent) + sends reward mail (center capital materials ×2)', async () => {
    await seed('active');
    const ranking = await svc.settleSeason(W);
    expect(ranking[0]).toMatchObject({ scope: 'family', familyId: familyId(W, 'AA'), nationCount: 2 });

    // seasonResults written to database (idempotent _id + tier).
    const doc = await m.collections.seasonResults.findOne({ _id: `${W}:s${SEASON}` });
    expect(doc).toBeTruthy();
    expect(doc!.ranking[0]).toMatchObject({ rank: 1, tier: 'champion', id: familyId(W, 'AA') });

    // Champion alice receives reward mail: center capital → scrap ×2. Materials use kind:'material' (→ SaveData.materials
    // unified progression pool, SLG8), not the generic 'item' kind (which goes to the inventory.items orphan bucket).
    const aliceMail = mailCalls.find((x) => x.accountId === 'alice');
    expect(aliceMail).toBeTruthy();
    expect(aliceMail!.dispatchKey).toBe(`slg-settle:${W}:s${SEASON}`);
    const scrap = aliceMail!.content.attachments!.find((a) => a.kind === 'material' && a.id === 'scrap');
    expect(scrap!.count).toBe(SETTLE_REWARDS.champion.items.scrap * CENTER_CAPITAL_MULT);

    // Re-entry: world is already settling; a second settle call must not create a duplicate record ($setOnInsert).
    const before = doc!.settledAt;
    await svc.settleSeason(W);
    const again = await m.collections.seasonResults.findOne({ _id: `${W}:s${SEASON}` });
    expect(again!.settledAt).toBe(before);
    expect(await m.collections.seasonResults.countDocuments({ worldId: W })).toBe(1);
  });

  it('settle: battle pass holders receive extra reward mail (S8-8 extra-settlement-reward tier)', async () => {
    await seed('active');
    // Grant alice a battle pass; bob has none.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'alice') },
      { $set: { hasBattlePass: true } },
    );
    await svc.settleSeason(W);

    const bpMails = mailCalls.filter((x) => x.dispatchKey === `slg-settle-bp:${W}:s${SEASON}`);
    // Only alice (the battle pass holder) receives the extra mail.
    expect(bpMails).toHaveLength(1);
    expect(bpMails[0]!.accountId).toBe('alice');
    // Mail includes the BP_SETTLE_EXTRA materials.
    const scrap = bpMails[0]!.content.attachments!.find((a) => a.kind === 'material' && a.id === 'scrap');
    expect(scrap!.count).toBe(BP_SETTLE_EXTRA.items.scrap);
    // Non-holder (bob) receives no BP mail.
    expect(bpMails.find((x) => x.accountId === 'bob')).toBeUndefined();
  });

  it('auto-settle: processDueSeasonSettlement settles only due active worlds, idempotently (§17.14)', async () => {
    await seed('active');
    const NOW = 1_700_000_000_000; // matches the fixed WorldService clock in beforeEach

    // Clock not yet elapsed → not settled.
    await m.collections.worlds.updateOne({ _id: W }, { $set: { settleAt: NOW + 1000 } });
    expect(await svc.processDueSeasonSettlement()).toEqual([]);
    expect((await m.collections.worlds.findOne({ _id: W }))!.status).toBe('active');

    // Clock elapsed (settleAt ≤ now) → settled once: status → settling + seasonResults written.
    await m.collections.worlds.updateOne({ _id: W }, { $set: { settleAt: NOW } });
    expect(await svc.processDueSeasonSettlement()).toEqual([W]);
    expect((await m.collections.worlds.findOne({ _id: W }))!.status).toBe('settling');
    expect(await m.collections.seasonResults.countDocuments({ _id: `${W}:s${SEASON}` })).toBe(1);

    // Idempotent: the world is now 'settling' (no longer 'active'), so a second pass does not re-settle.
    expect(await svc.processDueSeasonSettlement()).toEqual([]);
    expect(await m.collections.seasonResults.countDocuments({ worldId: W })).toBe(1);
  });

  it('reset: reset without settling first is rejected (prevents history loss)', async () => {
    await seed('active'); // status=active, not yet settled
    await expect(svc.resetSeason(W)).rejects.toMatchObject({ code: 'WORLD_CLOSED' });
  });

  it('reset: after settle clears archive + family season state zeroed + status open + engineVersion re-pinned', async () => {
    await seed('active');
    await svc.settleSeason(W);              // → settling
    await svc.resetSeason(W);               // settling → resetting → open

    const w = await m.collections.worlds.findOne({ _id: W });
    expect(w!.status).toBe('open');
    expect(w!.population).toBe(0);
    expect(w!.engineVersion).toBe(ENGINE_VERSION);
    expect(await m.collections.nations.countDocuments({ worldId: W, ownerId: { $exists: true } })).toBe(0);

    // Family season state is zeroed on the socialsvc mirror (worldsvc no longer owns a families collection):
    // both active families' SLG state must have been reset, and the mirror reflects zeroed prosperity + cleared sect.
    expect(socialsvc.slgResets.sort()).toEqual([familyId(W, 'AA'), familyId(W, 'BB')].sort());
    const [aa] = await socialsvc.getFamiliesByIds([familyId(W, 'AA')]);
    expect(aa).toMatchObject({ prosperity: 0 });
    expect(aa!.sectId).toBeUndefined();
  });

  it('reset: resetting intermediate state can resume (idempotent)', async () => {
    await seed('resetting'); // simulate a previous reset that crashed mid-way at resetting
    await expect(svc.resetSeason(W)).resolves.toBeTruthy();
    expect((await m.collections.worlds.findOne({ _id: W }))!.status).toBe('open');
  });

  describe('admin /admin/world/* X-Internal-Key gate (C4)', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      await seed('active');
      server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: KEY }, svc, {} as never, {} as never, {} as never);
      await new Promise<void>((res) => server.on('listening', res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => server?.close());

    it('no key → 401', async () => {
      const r = await fetch(`${base}/admin/world/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(401);
      server.close();
    });

    it('player JWT (no internal key) calling reset → 401', async () => {
      const token = signToken('acct-player', { secret: SECRET });
      const r = await fetch(`${base}/admin/world/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(401);
      server.close();
    });

    it('with X-Internal-Key → 200 (list + settle work)', async () => {
      const list = await fetch(`${base}/admin/world/list`, { headers: { 'x-internal-key': KEY } });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { ok: boolean; data: Array<{ worldId: string }> };
      expect(body.data.some((x) => x.worldId === W)).toBe(true);

      const r = await fetch(`${base}/admin/world/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': KEY }, body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(200);
      server.close();
    });
  });
});
