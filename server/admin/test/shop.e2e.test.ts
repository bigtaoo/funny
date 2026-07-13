// admin SLG shop price override e2e (SLG_DESIGN §8/G7): real Mongo, dedicated database.
//   getShopConfig lists all 9 catalog items with default/effective/doc; upsertShopItem validates + persists +
//   audits; getInternalShopPrices (worldsvc's polling source) returns raw docs; capability slg.shop.manage
//   is required (support role lacks it → forbidden). Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_SHOP_ITEMS } from '@nw/shared';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type { MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, PlayerProfile, StatsClient } from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_shop_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.shop.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

let t = 1000;
const now = (): number => t++;

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0 }),
};
class FakeMail implements MailDispatcher {
  available = true;
  async send(req: MailSendReq): Promise<MailSendRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
  async preview(req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
}
const stubPlayer: PlayerClient = {
  available: true,
  lookupByPublicId: async (): Promise<PlayerProfile | null> => null,
};

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin SLG shop price overrides e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let root: Actor;
  let support: Actor;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    svc = new AdminService({ cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(), now });
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
    support = await actorOf(svc, 'csr');
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('getShopConfig lists all 9 catalog items with doc=null before any override', async () => {
    const rows = await svc.getShopConfig();
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.doc).toBeNull();
      expect(row.effective).toEqual(row.default);
    }
  });

  it('upsertShopItem persists a cost override, reflected in getShopConfig.effective and getInternalShopPrices', async () => {
    const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;
    const doc = await svc.upsertShopItem(root, 'slg_res_s', { cost: 42 });
    expect(doc.cost).toBe(42);
    expect(doc.updatedBy).toBe(root.adminId);

    const rows = await svc.getShopConfig();
    const row = rows.find((r) => r.id === 'slg_res_s')!;
    expect(row.doc).not.toBeNull();
    expect(row.effective.cost).toBe(42);
    expect(row.effective.effect).toEqual(item.effect); // effect untouched, only cost overridden
    expect(row.default.cost).toBe(item.cost); // default is unaffected by the override

    const internal = await svc.getInternalShopPrices();
    expect(internal).toHaveLength(1);
    expect(internal[0]!.cost).toBe(42);
  });

  it('rejects an unknown item id', async () => {
    await expect(svc.upsertShopItem(root, 'made_up', { cost: 10 })).rejects.toThrow(AdminError);
  });

  it('rejects a non-positive cost', async () => {
    await expect(svc.upsertShopItem(root, 'slg_res_s', { cost: 0 })).rejects.toThrow(AdminError);
    await expect(svc.upsertShopItem(root, 'slg_res_s', { cost: -5 })).rejects.toThrow(AdminError);
  });

  it('writes an audit entry on every override', async () => {
    await svc.upsertShopItem(root, 'slg_res_s', { cost: 42 });
    const audit = await m.collections.auditLog.find({ action: 'slg.shop.price.update' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe('slg_res_s');
    expect(audit[0]!.actor).toBe(root.adminId);
  });

  it('support role lacks slg.shop.manage (capability enforced by httpApi.requireCap, sanity-checked here via role table)', async () => {
    // The service methods themselves don't gate on capability (httpApi does, via requireCap before calling svc.*) —
    // this asserts the role/capability wiring that httpApi relies on for this endpoint.
    const { roleHasCapability } = await import('@nw/shared');
    expect(roleHasCapability(support.role, 'slg.shop.manage')).toBe(false);
    expect(roleHasCapability(root.role, 'slg.shop.manage')).toBe(true);
  });
});
