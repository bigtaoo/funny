// admin content-moderation word list overlay e2e (CONTENT_MODERATION_DESIGN.md §3.2): real Mongo, dedicated database.
//   getWordlistConfig lists all 4 regions with builtin/overlay; addWord/removeWord validate + persist + audit;
//   getInternalWordlists (consumer polling source) returns raw docs; capability moderation.wordlist.manage
//   is required (support role lacks it → forbidden). Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { REGION_WORDLISTS } from '@nw/shared';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type { MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, PlayerProfile, StatsClient } from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_moderation_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.moderation.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

describe.skipIf(!mongo)('admin content-moderation word list overlays e2e', () => {
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

  it('getWordlistConfig lists all 4 regions with empty overlay before any edit', async () => {
    const rows = await svc.getWordlistConfig();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.overlay).toEqual([]);
      expect(row.builtin).toEqual(REGION_WORDLISTS[row.region]);
      expect(row.updatedAt).toBeUndefined();
    }
  });

  it('addWord persists a lowercased word, reflected in getWordlistConfig.overlay and getInternalWordlists', async () => {
    const doc = await svc.addWord(root, 'de', 'Testverbot');
    expect(doc.words).toEqual(['testverbot']);
    expect(doc.updatedBy).toBe(root.adminId);

    const rows = await svc.getWordlistConfig();
    const de = rows.find((r) => r.region === 'de')!;
    expect(de.overlay).toEqual(['testverbot']);
    expect(de.builtin).toEqual(REGION_WORDLISTS.de); // built-in floor unaffected

    const internal = await svc.getInternalWordlists();
    expect(internal).toHaveLength(1);
    expect(internal[0]!.words).toEqual(['testverbot']);
  });

  it('addWord is idempotent (adding an existing word does not duplicate it)', async () => {
    await svc.addWord(root, 'en', 'zzztest');
    const doc = await svc.addWord(root, 'en', 'ZZZTEST');
    expect(doc.words).toEqual(['zzztest']);
  });

  it('removeWord drops a word; removing a non-existent word is a no-op', async () => {
    await svc.addWord(root, 'cn', '测试词');
    const doc = await svc.removeWord(root, 'cn', '测试词');
    expect(doc.words).toEqual([]);
    const again = await svc.removeWord(root, 'cn', '测试词');
    expect(again.words).toEqual([]);
  });

  it('rejects an unknown region', async () => {
    await expect(svc.addWord(root, 'fr', 'x')).rejects.toThrow(AdminError);
    await expect(svc.removeWord(root, 'fr', 'x')).rejects.toThrow(AdminError);
  });

  it('rejects an empty or oversized word', async () => {
    await expect(svc.addWord(root, 'en', '   ')).rejects.toThrow(AdminError);
    await expect(svc.addWord(root, 'en', 'x'.repeat(65))).rejects.toThrow(AdminError);
  });

  it('writes an audit entry on every add/remove', async () => {
    await svc.addWord(root, 'en', 'zzztest');
    await svc.removeWord(root, 'en', 'zzztest');
    const audit = await m.collections.auditLog.find({ action: 'moderation.wordlist.update' }).toArray();
    expect(audit).toHaveLength(2);
    expect(audit[0]!.target).toBe('en');
    expect(audit[0]!.actor).toBe(root.adminId);
  });

  it('support role lacks moderation.wordlist.manage (capability enforced by httpApi.requireCap, sanity-checked here via role table)', async () => {
    // The service methods themselves don't gate on capability (httpApi does, via requireCap before calling svc.*) —
    // this asserts the role/capability wiring that httpApi relies on for this endpoint.
    const { roleHasCapability } = await import('@nw/shared');
    expect(roleHasCapability(support.role, 'moderation.wordlist.manage')).toBe(false);
    expect(roleHasCapability(root.role, 'moderation.wordlist.manage')).toBe(true);
  });
});
