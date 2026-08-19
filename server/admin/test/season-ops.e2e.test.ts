// admin SLG season lifecycle ops e2e (G7/§17.7; 2026-08-10 fix, §17.15): real Mongo, dedicated database.
//   Covers the WorldMixin proxy methods (open/settle/reset/close/merge/allocate) previously untested at the
//   admin layer — season-audit.e2e.test.ts only exercises the anomaly-audit-ticket flow and stubs FakeWorld's
//   season methods as no-ops. Verifies: each method forwards the right args to WorldClient + writes the right
//   AuditAction; slgResetSeason's "must settle before reset" operational guard; capability wiring (support role
//   lacks slg.season.manage). Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type {
  MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes,
  PlayerClient, PlayerProfile, StatsClient, WorldClient, SlgWorldSummary, SlgAllocateResult,
} from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_season_ops_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.season-ops.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

let t = 1000;
const now = (): number => t++;

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0, gameLoad: 0 }),
};
const stubPlayer: PlayerClient = {
  available: false,
  lookupByPublicId: async (): Promise<PlayerProfile | null> => null,
  // Not exercised by this suite — throw rather than answer, so a route that starts calling them
  // fails loudly instead of quietly seeing `undefined`.
  lookupByAccountId: () => { throw new Error('stubPlayer.lookupByAccountId is not stubbed'); },
  search: () => { throw new Error('stubPlayer.search is not stubbed'); },
  resetPassword: () => { throw new Error('stubPlayer.resetPassword is not stubbed'); },
};
class FakeMail implements MailDispatcher {
  available = true;
  async send(_req: MailSendReq): Promise<MailSendRes> { return { ok: true, recipientCount: 1 }; }
  async preview(_req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: 1 }; }
}

/** Records every call it receives so tests can assert exact forwarded args, in addition to being a working stub. */
class FakeWorld implements WorldClient {
  available = true;
  calls: Array<{ method: string; args: unknown[] }> = [];
  worlds: SlgWorldSummary[] = [];
  allocateResult: SlgAllocateResult = { shardCount: 1, worldIds: ['s2-0'], allocatedFamilies: 0 };

  async listWorlds(): Promise<SlgWorldSummary[]> { return this.worlds; }
  async openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    this.calls.push({ method: 'openWorld', args: [worldId, season, shard, capacity] });
  }
  async settleWorld(worldId: string): Promise<unknown> {
    this.calls.push({ method: 'settleWorld', args: [worldId] });
    return { ranking: [] };
  }
  async resetWorld(worldId: string): Promise<unknown> {
    this.calls.push({ method: 'resetWorld', args: [worldId] });
    return { reset: true };
  }
  async closeWorld(worldId: string): Promise<void> {
    this.calls.push({ method: 'closeWorld', args: [worldId] });
  }
  async mergeWorld(worldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }> {
    this.calls.push({ method: 'mergeWorld', args: [worldId, targetWorldId] });
    return { moved: 3, failed: ['stuck-acct'] };
  }
  async allocateNextSeason(season: number, capacity?: number): Promise<SlgAllocateResult> {
    this.calls.push({ method: 'allocateNextSeason', args: [season, capacity] });
    return this.allocateResult;
  }
  async listMapTemplates() { return []; }
  async generateMapTemplate() { return { templateId: '', width: 0, height: 0, version: 1, tileCount: 0, active: false, createdAt: 0, updatedAt: 0 }; }
  async getMapTemplateTiles() { return []; }
  async saveMapTemplateTiles() { return { updated: 0 }; }
  async activateMapTemplate() {}
  async deleteMapTemplate() {}
}

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin SLG season lifecycle ops e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let world: FakeWorld;
  let root: Actor;
  let support: Actor;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    world = new FakeWorld();
    svc = new AdminService({ cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(), world, now });
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
    support = await actorOf(svc, 'csr');
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('slgOpenSeason proxies to WorldClient.openWorld and audits slg.season.open', async () => {
    await svc.slgOpenSeason(root.adminId, 's9-0', 9, 0, 10000);
    expect(world.calls).toEqual([{ method: 'openWorld', args: ['s9-0', 9, 0, 10000] }]);
    const audit = await m.collections.auditLog.find({ action: 'slg.season.open' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: root.adminId, target: 's9-0', summary: 's9-0 cap=10000' });
  });

  it('slgSettleSeason proxies to WorldClient.settleWorld and audits slg.season.settle', async () => {
    const r = await svc.slgSettleSeason(root.adminId, 's9-0');
    expect(world.calls).toEqual([{ method: 'settleWorld', args: ['s9-0'] }]);
    expect(r).toEqual({ ranking: [] });
    const audit = await m.collections.auditLog.find({ action: 'slg.season.settle' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: root.adminId, target: 's9-0' });
  });

  it('slgCloseSeason proxies to WorldClient.closeWorld and audits slg.season.close', async () => {
    await svc.slgCloseSeason(root.adminId, 's9-0');
    expect(world.calls).toEqual([{ method: 'closeWorld', args: ['s9-0'] }]);
    const audit = await m.collections.auditLog.find({ action: 'slg.season.close' }).toArray();
    expect(audit).toHaveLength(1);
  });

  it('slgMergeShard proxies to WorldClient.mergeWorld, returns the result, and audits slg.season.merge with a moved/failed summary', async () => {
    const r = await svc.slgMergeShard(root.adminId, 's9-1', 's9-0');
    expect(world.calls).toEqual([{ method: 'mergeWorld', args: ['s9-1', 's9-0'] }]);
    expect(r).toEqual({ moved: 3, failed: ['stuck-acct'] });
    const audit = await m.collections.auditLog.find({ action: 'slg.season.merge' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: 's9-1', summary: '→s9-0 moved=3 failed=1' });
  });

  it('slgResetSeason rejects with 409 when the world has not been settled yet (must settle before reset)', async () => {
    world.worlds = [{ worldId: 's9-0', season: 9, shard: 0, status: 'open', population: 0, capacity: 10000, openAt: 1 }];
    await expect(svc.slgResetSeason(root.adminId, 's9-0')).rejects.toMatchObject({ status: 409 });
    expect(world.calls.find((c) => c.method === 'resetWorld')).toBeUndefined(); // guard blocks before the proxy call
    expect(await m.collections.auditLog.find({ action: 'slg.season.reset' }).toArray()).toHaveLength(0);
  });

  it('slgResetSeason proceeds and audits slg.season.reset once the world is settling', async () => {
    world.worlds = [{ worldId: 's9-0', season: 9, shard: 0, status: 'settling', population: 0, capacity: 10000, openAt: 1 }];
    const r = await svc.slgResetSeason(root.adminId, 's9-0');
    expect(world.calls).toEqual([{ method: 'resetWorld', args: ['s9-0'] }]);
    expect(r).toEqual({ reset: true });
    expect(await m.collections.auditLog.find({ action: 'slg.season.reset' }).toArray()).toHaveLength(1);
  });

  it('slgAllocateNextSeason proxies to WorldClient.allocateNextSeason, returns its result, and audits slg.season.allocate with a shard/worldId/family summary', async () => {
    world.allocateResult = { shardCount: 2, worldIds: ['s10-0', 's10-1'], allocatedFamilies: 7 };
    const r = await svc.slgAllocateNextSeason(root.adminId, 10, 5000);
    expect(world.calls).toEqual([{ method: 'allocateNextSeason', args: [10, 5000] }]);
    expect(r).toEqual({ shardCount: 2, worldIds: ['s10-0', 's10-1'], allocatedFamilies: 7 });
    const audit = await m.collections.auditLog.find({ action: 'slg.season.allocate' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: root.adminId, target: 'season 10',
      summary: 'shards=2 worldIds=s10-0,s10-1 families=7',
    });
  });

  it('slgAllocateNextSeason forwards an omitted capacity as undefined, not a synthesized default', async () => {
    await svc.slgAllocateNextSeason(root.adminId, 11);
    expect(world.calls).toEqual([{ method: 'allocateNextSeason', args: [11, undefined] }]);
  });

  it('support role lacks slg.season.manage (capability enforced by httpApi.requireCap, sanity-checked here via role table); slg.season.view is granted more broadly', async () => {
    // The service methods themselves don't gate on capability (httpApi does, via requireCap before calling svc.*) —
    // this asserts the role/capability wiring that httpApi relies on for every route in slgRoutes.ts's manage branch,
    // including the new /admin/slg/season/allocate route.
    const { roleHasCapability } = await import('@nw/shared');
    expect(roleHasCapability(support.role, 'slg.season.manage')).toBe(false);
    expect(roleHasCapability(root.role, 'slg.season.manage')).toBe(true);
    expect(roleHasCapability(support.role, 'slg.season.view')).toBe(false);
    expect(roleHasCapability('viewer', 'slg.season.view')).toBe(true);
    expect(roleHasCapability('viewer', 'slg.season.manage')).toBe(false);
  });
});
