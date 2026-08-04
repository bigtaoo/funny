// PvE L1 replay spot-check re-computation end-to-end (PVE_INTEGRITY_PLAN §8.6 step 3): real Mongo + injected fake gateway judge.
//   First clear triggers spot-check → materials withheld + needsReplay/verifyId; /pve/verify: re-compute passes → grant materials /
//   star mismatch → mark suspicious, do not grant / no available judge → benefit-of-doubt grant; duplicate upload is idempotent;
//   no gateway configured → no spot-check (grant immediately, reverts to prior behaviour).
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../dist/gatewayClient.js';
import { seedEquipment } from './helpers/equipment.js';
import { seedCard } from './helpers/cards.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pveverify_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve-verify.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Configurable fake judge: records the last judge call's arguments and returns a preset verdict. */
class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, stars: 3, judgeAccountId: 'judge-1' };
  last?: JudgeReq;
  async judge(req: JudgeReq): Promise<JudgeRes> {
    this.last = req;
    return this.next;
  }
  async push(): Promise<void> {}
  async presence(): Promise<Record<string, boolean>> {
    return {};
  }
  async invalidateFriends(): Promise<void> {}
}

describe.skipIf(!mongo)('pve L1 verify e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  let token: string;
  let starterCardInv: Record<string, unknown>;
  const b = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3, pveUpgrades?: Record<string, number>) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars, ...(pveUpgrades ? { pveUpgrades } : {}) } });
  const verify = (verifyId: string, endFrame = 100) =>
    app.inject({ method: 'POST', url: '/pve/verify', headers: auth(), payload: { verifyId, endFrame, frames: [] } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway });
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-verify-dev-1' } }));
    token = r.data.token;
    // fresh accounts start with a non-empty Hero Roster (starter cards, CHARACTER_CARDS_DESIGN §4) — /auth/device
    // itself doesn't return `save`, so fetch it separately.
    const save = b(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    starterCardInv = save.data.save.cardInv;
  });
  afterAll(async () => { if (app) await app.close(); });

  it('first clear is selected for spot-check: materials withheld + needsReplay/verifyId; progress/stars already written', async () => {
    const r = b(await clear('ch1_lv1', 3));
    expect(r.data.needsReplay).toBe(true);
    expect(typeof r.data.verifyId).toBe('string');
    expect(r.data.granted).toEqual({}); // materials not granted yet
    expect(r.data.save.materials.scrap ?? 0).toBe(0);
    expect(r.data.save.progress.cleared).toContain('ch1_lv1'); // unlock proceeds as normal
    expect(r.data.save.progress.stars['ch1_lv1']).toBe(3);
  });

  it('re-computation passes (stars >= claimed) → grant materials + verified', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 3 };
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(v.data.save.materials.scrap).toBe(6);
    // Judge received PvE re-computation arguments (levelId + server-authoritative blueprint: the account's
    // real starter Hero Roster, not an empty one — see the regression test below for a non-starter snapshot).
    expect(gateway.last?.levelId).toBe('ch1_lv1');
    expect(JSON.parse(gateway.last?.cardInstancesJson ?? '{}')).toEqual(starterCardInv);
    expect(gateway.last?.equipmentInvJson).toBe('{}');
  });

  it('regression (2026-07-26 fix, PVE_INTEGRITY §9): the judge receives the account\'s real cardInv/equipmentInv, not an empty blueprint', async () => {
    // Root cause: pveVerify used to snapshot the dead pveUpgrades/unitLevels fields (the engine dropped those
    // GameConfig params in the CC-1 migration), so the judge always recomputed with unleveled, gear-less units
    // regardless of the player's real Hero Roster investment. Seed a leveled + equipped card onto the account
    // (mirrors CardInstance/EquipmentInstance, server/shared/src/types.ts) before the spot-checked clear, then
    // assert the exact snapshot reaches gateway.judge() as JSON — proving pveVerify no longer discards it.
    const seededCardInv = {
      card_test: { id: 'card_test', defId: 'lichuang', level: 9, gear: { weapon: 'eq_test' }, locked: false },
    };
    const seededEquipment = { id: 'eq_test', defId: 'test_weapon', rarity: 'epic' as const, level: 9, affixes: [{ id: 'm_atk', value: 80 }] };
    const seededEquipmentInv = { eq_test: seededEquipment };
    const accountId = (await m.collections.accounts.findOne({}))!._id;
    // cardInv lives in its own `cardInstances` collection since the 2026-07-27 storage split (cards.ts) —
    // replace the account's whole roster (starter cards included) with just the seeded card, mirroring the
    // old direct `$set: {'save.cardInv': seededCardInv}` replace-the-whole-map semantics.
    await m.collections.cardInstances.deleteMany({ accountId });
    await seedCard(m, accountId, seededCardInv.card_test);
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.cardInvCount': 1 } });
    // equipmentInv lives in its own `equipmentInstances` collection since the 2026-07-26 storage split (equipment.ts).
    await seedEquipment(m, accountId, seededEquipment);
    gateway.next = { ok: true, stars: 3 };
    const c = b(await clear('ch1_lv1', 3));
    await verify(c.data.verifyId); // gateway.judge() is only actually invoked here, not by /pve/clear itself
    expect(JSON.parse(gateway.last?.cardInstancesJson ?? '{}')).toEqual(seededCardInv);
    expect(JSON.parse(gateway.last?.equipmentInvJson ?? '{}')).toEqual(seededEquipmentInv);
  });

  it('re-computation stars < claimed → mark suspicious, do not grant materials', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 1 }; // re-computation yields only 1 star, claimed 3
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(false);
    expect(v.data.granted).toEqual({});
    expect(v.data.save.materials.scrap ?? 0).toBe(0);
  });

  it('no judge available (ok:false) → benefit-of-doubt, grant materials', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: false }; // no candidate / timeout / re-computation failure
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
  });

  it('duplicate upload of the same verifyId → idempotent, not granted twice', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 3 };
    await verify(c.data.verifyId);
    const again = b(await verify(c.data.verifyId));
    expect(again.data.granted).toEqual({}); // already settled, no further grant
    expect(again.data.save.materials.scrap).toBe(6); // granted exactly once
  });

  it('regression (2026-08-03 fix): two truly concurrent /pve/verify submissions for the same verifyId grant materials exactly once', async () => {
    // Root cause: pveVerify's idempotency guard read doc.status BEFORE the (potentially slow) gateway.judge()
    // call, then wrote the settled status without checking whether its own write actually matched. Two
    // concurrent requests could both pass the initial pending-check, both run the judge, and both then
    // deliver rewards — this test widens that race window with a slow fake judge and fires both requests
    // via Promise.all so they genuinely overlap.
    const c = b(await clear('ch1_lv1', 3));
    let resolveJudge!: () => void;
    const gate = new Promise<void>((resolve) => { resolveJudge = resolve; });
    gateway.judge = async (req) => {
      gateway.last = req;
      await gate; // both concurrent calls block here until released together
      return { ok: true, stars: 3 };
    };
    const call1 = verify(c.data.verifyId);
    const call2 = verify(c.data.verifyId);
    // Give both requests a tick to reach (and pass) the pending-status read before releasing the judge.
    await new Promise((r) => setTimeout(r, 20));
    resolveJudge();
    const [r1, r2] = (await Promise.all([call1, call2])).map(b);
    // Exactly one of the two should have delivered materials; the other must take the idempotent path.
    const grantedCount = [r1, r2].filter((r) => r.data.granted?.scrap > 0).length;
    expect(grantedCount).toBe(1);
    const finalSave = b(await app.inject({ method: 'GET', url: '/save', headers: auth() })).data.save;
    expect(finalSave.materials.scrap).toBe(6); // granted exactly once, not twice
  });

  it('unknown / unauthorized verifyId → 404', async () => {
    expect((await verify('no-such-id')).statusCode).toBe(404);
  });

  it('repeated rejections no longer auto-ban (2026-07-18 policy change): each files an open review ticket instead', async () => {
    // A legitimate, heavily-invested account can clear early content with zero input (base/hero auto-attack
    // alone), which a naive 3-strikes auto-ban can't distinguish from a forged empty replay — see
    // PVE_INTEGRITY_PLAN.md. So a rejection now only files a review ticket for a human to decide; it never
    // bans on its own. Drive three distinct first-clears — ch1_lv1→lv2→lv3 (only first clears are
    // force-sampled for spot-check) — each rejected via verify.
    gateway.next = { ok: true, stars: 1 }; // re-computation yields 1 star, claimed 3 → rejected

    for (const levelId of ['ch1_lv1', 'ch1_lv2', 'ch1_lv3']) {
      const c = b(await clear(levelId, 3));
      expect(c.data.needsReplay).toBe(true); // first clear is always spot-checked
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(false); // rejected → pveRejectCount++, no ban
      expect(v.data.save.antiCheat?.pveBanned).toBeFalsy();
    }

    // Not blocked: 4th pveClear proceeds normally — no auto-ban regardless of reject count.
    const notBlocked = await clear('ch1_lv1', 3);
    expect(notBlocked.statusCode).toBe(200);

    // Every rejection filed an open pve_reject review ticket; the 3rd (reaching the old ban threshold) is 'high' severity.
    const reviews = await m.collections.antiCheatReviews.find({ kind: 'pve_reject' }).sort({ ts: 1 }).toArray();
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.status === 'open')).toBe(true);
    expect(reviews.map((r) => r.severity)).toEqual(['normal', 'normal', 'high']);
  });

  it('three-strikes ban: pveVerify returns 403 for a banned account', async () => {
    gateway.next = { ok: true, stars: 3 }; // normal first clear
    const c = b(await clear('ch1_lv1', 3));
    // manually set pveBanned in save (simulates an already-banned account)
    await m.collections.saves.updateOne(
      { _id: c.data.save._id ?? (await m.collections.saves.findOne({}))!._id },
      { $set: { 'save.antiCheat.pveBanned': true } },
    );
    if (c.data.needsReplay) {
      const r = await verify(c.data.verifyId);
      expect(r.statusCode).toBe(403);
    }
  });

  it('no gateway configured → no spot-check, first clear grants materials immediately (reverts to prior behaviour)', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k' }); // no gateway
    const r2 = b(await app2.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-verify-dev-2' } }));
    const res = b(await app2.inject({
      method: 'POST', url: '/pve/clear',
      headers: { authorization: `Bearer ${r2.data.token}` },
      payload: { levelId: 'ch1_lv1', stars: 3 },
    }));
    expect(res.data.needsReplay).toBeUndefined();
    expect(res.data.granted).toEqual({ scrap: 6, lead: 2 });
    await app2.close();
  });
});
