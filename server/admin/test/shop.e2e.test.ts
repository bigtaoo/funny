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
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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
  // Not exercised by this suite — throw rather than answer, so a route that starts calling them
  // fails loudly instead of quietly seeing `undefined`.
  lookupByAccountId: () => { throw new Error('stubPlayer.lookupByAccountId is not stubbed'); },
  search: () => { throw new Error('stubPlayer.search is not stubbed'); },
  resetPassword: () => { throw new Error('stubPlayer.resetPassword is not stubbed'); },
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

  // Investigation (server-test-backlog project 4): upsertShopItem fetches the existing override doc
  // (`before`) but ONLY uses it for the audit summary string — it is never merged into the new doc.
  // The new doc is built solely from this call's `input` and then written with `replaceOne` (whole
  // document replace, not a field-level $set). So a follow-up call that supplies only `cost` silently
  // drops a previously-persisted `effect` override (and vice versa).
  //
  // Verdict: this is INTENTIONAL whole-document-replace semantics, not a bug — pinned here rather than
  // fixed, for two reasons:
  //   1. The sibling FlagsMixin.upsertFlag (src/service/flags.ts) has the exact same shape (fetches
  //      `before`, uses it only for the audit diff, then replaceOne's a doc built from just this call's
  //      input) — a second independent mixin from the same feature-flags-style pattern, not a one-off slip.
  //   2. The only real caller, the ops UI (tools/ops/src/pages/slgShop.ts `pageSlgShop`), pre-fills its
  //      cost + effect form fields from the CURRENT effective values on load and always submits BOTH
  //      together on Save (`input = { cost: costVal }` then unconditionally adds `effect` whenever the
  //      item kind has an effect field at all) — so in the one production code path, a partial-input call
  //      that would lose data never actually happens.
  // This test locks the current (replace) behavior in place so it isn't "fixed" into a merge by accident,
  // and so any future caller that does send partial input (e.g. a scripted/curl PUT) has documented,
  // tested proof of what happens.
  it('upsertShopItem replaces the whole override document — a later cost-only call silently drops a previously-set effect override (documented, not a bug: see comment above)', async () => {
    const withEffect = await svc.upsertShopItem(root, 'slg_speedup_1h', { cost: 250, effect: { duration_sec: 7200 } });
    expect(withEffect.cost).toBe(250);
    expect(withEffect.effect).toEqual({ duration_sec: 7200 });

    // Follow-up call touches only cost — effect is NOT repeated in this input.
    const costOnly = await svc.upsertShopItem(root, 'slg_speedup_1h', { cost: 300 });
    expect(costOnly.cost).toBe(300);
    expect(costOnly.effect).toBeUndefined(); // the previously-set effect override is gone from the persisted doc

    const rows = await svc.getShopConfig();
    const row = rows.find((r) => r.id === 'slg_speedup_1h')!;
    // effective.effect falls back to the code default (duration_sec: 3600), NOT the 7200 set moments ago.
    expect(row.effective.effect).toEqual(row.default.effect);
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
