// SLG world season ops e2e (§17.5/§17.6/§17.7/§17.11): real Mongo dedicated database. Entire suite skipped if Mongo is unreachable.
//   • settleSeason: writes seasonResults (idempotent _id) + sends reward mail (materials/skins, center capital ×2, idempotent dispatchKey);
//   • resetSeason: guards (must settle first) + batched archive wipe + family season state zeroed + status→open + engineVersion re-pinned + idempotent resume;
//   • admin /admin/world/* gated by X-Internal-Key (no key / player JWT → rejected; valid key → allowed).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  signToken, familyId, playerWorldId, SLG_MAP_W, SLG_MAP_H,
  SETTLE_REWARDS, CENTER_CAPITAL_IDX, CENTER_CAPITAL_MULT, BP_SETTLE_EXTRA,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import { createWorldMongo, type WorldMongo, type FamilyDoc, type FamilyMemberDoc, type NationDoc, type WorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import type { WorldMailClient, WorldMailContent } from '../src/mailClient';

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

interface MailCall { accountId: string; dispatchKey: string; content: WorldMailContent }

describe.skipIf(!mongo)('worldsvc season ops e2e', () => {
  const m = mongo!;
  const mailCalls: MailCall[] = [];
  const fakeMail: WorldMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) { mailCalls.push({ accountId, dispatchKey, content }); },
  };
  const svc = new WorldService({
    cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, mail: fakeMail, now: () => 1_700_000_000_000,
  });

  /** Reset data and create one active world with two families holding nations (alice: center capital 9 + corner 0; bob: 1). */
  async function seed(status: WorldDoc['status'] = 'active'): Promise<void> {
    const c = m.collections;
    await Promise.all([
      c.worlds.deleteMany({}), c.families.deleteMany({}), c.familyMembers.deleteMany({}),
      c.nations.deleteMany({}), c.seasonResults.deleteMany({}), c.tiles.deleteMany({}),
      c.marches.deleteMany({}), c.playerWorld.deleteMany({}), c.sects.deleteMany({}), c.sectMessages.deleteMany({}),
    ]);
    mailCalls.length = 0;
    await c.worlds.insertOne({
      _id: W, season: SEASON, shard: 5, status, mapW: SLG_MAP_W, mapH: SLG_MAP_H,
      openAt: 1, capacity: 10000, population: 2, engineVersion: ENGINE_VERSION, rev: 1,
    });
    const fam = (tag: string, leader: string): FamilyDoc => ({
      _id: familyId(W, tag), worldId: W, name: `Fam${tag}`, tag, leaderId: leader,
      memberCount: 1, territoryCount: 1, prosperity: 1000, activity: 100, prosperityUpdatedAt: 1, rev: 1,
    });
    const mem = (tag: string, acct: string): FamilyMemberDoc => ({
      _id: `${W}:${acct}`, worldId: W, accountId: acct, familyId: familyId(W, tag), role: 'leader', joinedAt: 1,
    });
    await c.families.insertMany([fam('AA', 'alice'), fam('BB', 'bob')]);
    await c.familyMembers.insertMany([mem('AA', 'alice'), mem('BB', 'bob')]);
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

  it('settle: battle pass holders receive extra reward mail (S8-8 额外结算奖励档)', async () => {
    await seed('active');
    // Grant alice a battle pass; bob has none.
    await m.collections.playerWorld.insertOne({
      _id: playerWorldId(W, 'alice'), worldId: W, accountId: 'alice',
      troops: 0, troopCap: 0, resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: 0, hasBattlePass: true, rev: 0,
    });
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

    const aa = await m.collections.families.findOne({ _id: familyId(W, 'AA') });
    expect(aa).toMatchObject({ territoryCount: 0, prosperity: 0, activity: 0 });
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
