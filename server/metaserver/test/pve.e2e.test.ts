// PvE server-authoritative end-to-end (PVE_INTEGRITY_PLAN §8): /pve/clear completion settlement.
//   Validates unlock prerequisites, repeatable farming with material grants, daily cap capped.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, PVE_DAILY_CLEAR_REWARD_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { FindOneAndUpdateOptions } from 'mongodb';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes } from '../dist/gatewayClient.js';
import { FakeSocialsvc, ThrowingSocialsvc, fakeGateway } from './helpers/fakeClients.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('pve server-authoritative e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars } });
  /** Directly seed cleared levels (bypasses sequential unlock prerequisites), used to test final-level chapter counting. */
  const seedCleared = (cleared: string[]) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': cleared } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k' });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save
  });
  afterAll(async () => { if (app) await app.close(); });

  it('first level clear: grant materials + record stars + write cleared (server-authoritative)', async () => {
    const r = body(await clear('ch1_lv1', 3));
    expect(r.data.capped).toBe(false);
    expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(r.data.save.progress.cleared).toContain('ch1_lv1');
    expect(r.data.save.progress.stars['ch1_lv1']).toBe(3);
    expect(r.data.save.materials.scrap).toBe(6);
    // Material provenance (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): one materialInstances row per
    // material id granted by this single clear event (scrap + lead), tagged sourceType='pve_drop:<levelId>'.
    const insts = await m.collections.materialInstances.find({ accountId }).toArray();
    expect(insts).toHaveLength(2);
    const byId = new Map(insts.map((i) => [i.materialId, i]));
    expect(byId.get('scrap')).toMatchObject({ count: 6, sourceType: 'pve_drop:ch1_lv1' });
    expect(byId.get('lead')).toMatchObject({ count: 2, sourceType: 'pve_drop:ch1_lv1' });
    expect(typeof byId.get('scrap')?.obtainedAt).toBe('number');
  });

  it('author welcome mail (ONBOARDING_DESIGN §5.1): first-ever level clear sends an idempotent system mail with 1000 coins + mail_new push; a second clear does not resend it', async () => {
    const socialsvc = new FakeSocialsvc();
    const gw = fakeGateway({ available: true }) as GatewayClient & { pushed: { accountId: string; payload: unknown }[] };
    const welcomeApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', socialsvc, gateway: gw });
    const r = body(await welcomeApp.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `welcome-dev-${Math.random()}` } }));
    const welcomeToken = r.data.token as string;
    const welcomeAccountId = r.data.accountId as string;
    const welcomeAuth = { authorization: `Bearer ${welcomeToken}` };
    await welcomeApp.inject({ method: 'GET', url: '/save', headers: welcomeAuth }); // initialize save

    await welcomeApp.inject({ method: 'POST', url: '/pve/clear', headers: welcomeAuth, payload: { levelId: 'ch1_lv1', stars: 3 } });
    const mailId = `welcome.author:${welcomeAccountId}`;
    expect(socialsvc.mail.has(mailId)).toBe(true);
    expect(socialsvc.mail.get(mailId)?.attachments).toEqual([{ kind: 'coins', count: 1000 }]);
    expect(gw.pushed.some((p) => p.accountId === welcomeAccountId && (p.payload as { kind?: string }).kind === 'mail_new')).toBe(true);

    await welcomeApp.inject({ method: 'POST', url: '/pve/clear', headers: welcomeAuth, payload: { levelId: 'ch1_lv2', stars: 3 } });
    expect(socialsvc.mail.size).toBe(1); // not resent on the second-ever clear

    await welcomeApp.close();
  });

  it('author welcome mail is best-effort: a failed send does not block clear settlement (reward/progress still applied)', async () => {
    // gateway left unavailable (fakeGateway()'s default) — same as the plain `app` built in beforeEach —
    // so this clear takes the deterministic normal-settlement path, not the L1 judge spot-check path
    // (`hasReward && gateway.available`, service/pve.ts): isFirstClear alone forces a spot-check
    // (shouldSpotCheck, pveRewards.ts) whenever a judge IS available, which would defer materials to
    // /pve/verify and make this test about spot-check gating instead of the welcome-mail best-effort path.
    const gw = fakeGateway() as GatewayClient & { pushed: { accountId: string; payload: unknown }[] };
    // ThrowingSocialsvc.insertSystemMail rejects on every call (helpers/fakeClients.js) — pve.ts's
    // `.catch((e) => { req.log.warn(...); return null; })` around the mail send must swallow this.
    const failApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', socialsvc: new ThrowingSocialsvc(), gateway: gw });
    const r = body(await failApp.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `welcome-fail-dev-${Math.random()}` } }));
    const failToken = r.data.token as string;
    const failAuth = { authorization: `Bearer ${failToken}` };
    await failApp.inject({ method: 'GET', url: '/save', headers: failAuth }); // initialize save

    const clearRes = body(await failApp.inject({ method: 'POST', url: '/pve/clear', headers: failAuth, payload: { levelId: 'ch1_lv1', stars: 3 } }));
    expect(clearRes.data.capped).toBe(false);
    expect(clearRes.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(clearRes.data.save.progress.cleared).toContain('ch1_lv1');
    // No mail_new push — the (failed) send never reached the `if (mailResult?.inserted)` branch.
    expect(gw.pushed.some((p) => (p.payload as { kind?: string }).kind === 'mail_new')).toBe(false);

    await failApp.close();
  });

  // CC-2 Hero Roster model: a PvE level drop is granted as a CardInstance in `cardInv` (unitType → CARD_DEFS entry),
  // NOT the retired S12 `cardInventory`/`unitLevels` fields (removed from SaveData v4). `grantedCards` (cardKey→count)
  // remains the response contract (openapi.yml). Helper: count roster instances of a given defId.
  const defCount = (save: { cardInv: Record<string, { defId: string; level: number }> }, defId: string) =>
    Object.values(save.cardInv).filter((c) => c.defId === defId).length;
  /** Count roster instances of a given defId at a specific level (used to isolate the level-2 chapter-clear card from the level-1 drops). */
  const lvlCount = (save: { cardInv: Record<string, { defId: string; level: number }> }, defId: string, level: number) =>
    Object.values(save.cardInv).filter((c) => c.defId === defId && c.level === level).length;

  it('regression: a failed card-grant on /pve/clear leaves nothing committed, so a client retry does not double-grant materials/stats', async () => {
    // Root cause: settleNormalClear's consolidated write (progress/materials/equipment-slot/accrueStats/
    // retention) used to commit BEFORE the separate grantCards call — so if grantCards failed (its own
    // independent rev-guarded retry loop exhausted under save-document contention), the client saw a bare
    // 409 even though the consolidated write had already landed. A client retry of the same /pve/clear
    // request would then re-run the whole consolidated write from scratch and double-apply every additive
    // field in it (materials via applyMaterialAndEquipmentGrant, achievement stats via accrueStats) on top
    // of the already-committed delta, neither being idempotent across repeated calls. The fix reorders
    // grantCards to run FIRST, so its failure leaves nothing committed at all. Force ONLY grantCards's own
    // save write to lose its rev race (identified by it being the one that actually changes cardInvCount —
    // the consolidated pve write never touches that field) so the OTHER write is free to succeed or fail
    // on its own merits, whichever order the code under test actually runs them in.
    const realSaves = m.collections.saves;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async (
        filter: Parameters<typeof realSaves.findOneAndUpdate>[0],
        update: Parameters<typeof realSaves.findOneAndUpdate>[1],
        opts?: FindOneAndUpdateOptions,
      ) => {
        const current = await realSaves.findOne(filter as Record<string, unknown>);
        const incomingCardInvCount = (update as { $set?: { save?: { cardInvCount?: number } } }).$set?.save?.cardInvCount;
        const isCardGrantWrite = !!current && incomingCardInvCount !== undefined && incomingCardInvCount !== current.save.cardInvCount;
        if (isCardGrantWrite) return null; // force grantCards's own rev-guarded loop to exhaust
        return opts ? realSaves.findOneAndUpdate(filter, update, opts) : realSaves.findOneAndUpdate(filter, update);
      },
    } as typeof realSaves;
    const failingApp = await buildApp({ cols: { ...m.collections, saves: wrappedSaves }, jwt, internalKey: 'k' });
    try {
      const failed = await failingApp.inject({
        method: 'POST', url: '/pve/clear', headers: auth(),
        payload: { levelId: 'ch1_lv1', stars: 3, stats: { 'kill.archer': 3 } },
      });
      expect(failed.statusCode).toBe(409);
    } finally {
      await failingApp.close();
    }

    // Nothing committed: not cleared, no materials, no stats, no card.
    const afterFailure = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(afterFailure.data.save.progress.cleared).not.toContain('ch1_lv1');
    expect(afterFailure.data.save.materials.scrap ?? 0).toBe(0);
    expect(afterFailure.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    expect(defCount(afterFailure.data.save, 'lichuang')).toBe(1); // just the starter, no drop granted

    // Retry with the real (unwrapped) app, resending the SAME request (including stats): succeeds and
    // applies everything exactly once.
    const retried = body(await app.inject({
      method: 'POST', url: '/pve/clear', headers: auth(),
      payload: { levelId: 'ch1_lv1', stars: 3, stats: { 'kill.archer': 3 } },
    }));
    expect(retried.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(retried.data.save.progress.cleared).toContain('ch1_lv1');
    expect(retried.data.save.materials.scrap).toBe(6);
    expect(defCount(retried.data.save, 'lichuang')).toBe(2); // starter + exactly one drop, not two
    // The whole point of this regression test: accrueStats is additive and non-idempotent, so a double-run
    // of the consolidated write (the bug this fix closes) would have shown up as 6, not 3.
    expect(retried.data.save.stats?.['kill.archer'] ?? 0).toBe(3);
  });

  it('level drops unit card (CC-2): first chapter level grants an infantry Hero-Roster card + grantedCards', async () => {
    const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(defCount(before.data.save, 'lichuang')).toBe(1); // onboarding starter (infantry = lichuang)
    const r = body(await clear('ch1_lv1', 3)); // ch1 → infantry T1 x1
    expect(r.data.grantedCards).toEqual({ 'infantry:1': 1 });
    // Drop is granted as a fresh level-1 CardInstance (same as every other card source); starter is also level 1.
    expect(defCount(r.data.save, 'lichuang')).toBe(2);
    expect(Object.values(r.data.save.cardInv).filter((c: any) => c.defId === 'lichuang')).toHaveLength(2);
    expect(Object.values(r.data.save.cardInv).every((c: any) => c.defId !== 'lichuang' || c.level === 1)).toBe(true);
    // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): the PvE drop (not the starter copy) is tagged
    // sourceType='pve_drop:<levelId>' — distinguish it from the starter grant seeded before this clear.
    const dropped = Object.values(before.data.save.cardInv).map((c: any) => c.id) as string[];
    const newLichuang = (Object.values(r.data.save.cardInv) as Array<{ id: string; defId: string; sourceType?: string; obtainedAt?: number }>)
      .find((c) => c.defId === 'lichuang' && !dropped.includes(c.id));
    expect(newLichuang?.sourceType).toBe('pve_drop:ch1_lv1');
    expect(typeof newLichuang?.obtainedAt).toBe('number');
    // Final level (lv10) grants double cards.
    await seedCleared([
      'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5',
      'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9',
    ]);
    const r10 = body(await clear('ch1_lv10', 3));
    expect(r10.data.grantedCards).toEqual({ 'infantry:1': 2 });
    // ch1_lv10 is the chapter-1 finale → first clear ALSO grants a level-2 anchor card (§4, lichuang);
    // so lichuang = 2 (starter + earlier ch1_lv1 drop) + 2 (double lv10 drop, level 1) + 1 (chapter card, level 2) = 5.
    expect(defCount(r10.data.save, 'lichuang')).toBe(5);
  });

  it('chapter clear exclusive reward (§4): first clear of a chapter finale grants a level-2 anchor card; replay does not re-grant', async () => {
    // Unlock the chapter-1 finale (seed lv1..lv9), then clear it fresh.
    await seedCleared(['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9']);
    const r = body(await clear('ch1_lv10', 3));
    // ch1 anchor = lichuang (Tao, odd chapter): exactly one level-2 instance, distinct from the level-1 lv10 double drop.
    expect(lvlCount(r.data.save, 'lichuang', 2)).toBe(1);
    expect(r.data.save.stats['campaign.chaptersCleared']).toBe(1);
    // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): the exclusive chapter-clear anchor card is tagged
    // sourceType='pve_anchor:<chapterId>', distinct from the ordinary level-1 'pve_drop:<levelId>' tag.
    const anchor = (Object.values(r.data.save.cardInv) as Array<{ defId: string; level: number; sourceType?: string }>)
      .find((c) => c.defId === 'lichuang' && c.level === 2);
    expect(anchor?.sourceType).toBe('pve_anchor:ch1');
    // Replay the finale: no new chapter clear → no additional level-2 card (level-1 drops still repeat, but the exclusive reward is one-time).
    const r2 = body(await clear('ch1_lv10', 1));
    expect(lvlCount(r2.data.save, 'lichuang', 2)).toBe(1);
    expect(r2.data.save.stats['campaign.chaptersCleared']).toBe(1);
  });

  it('chapter clear exclusive reward (§4): even chapter grants the Anna-side anchor (ch2 → level-2 max)', async () => {
    // Seed ch1 fully cleared + ch2 lv1..lv9 to unlock the ch2 finale.
    const upto: string[] = [];
    for (let l = 1; l <= 10; l++) upto.push(`ch1_lv${l}`);
    for (let l = 1; l <= 9; l++) upto.push(`ch2_lv${l}`);
    await seedCleared(upto);
    const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(defCount(before.data.save, 'max')).toBe(0); // Anna anchors are not onboarding starters
    const r = body(await clear('ch2_lv10', 3));
    // ch2 anchor = max (Anna, even chapter, §5.1): one level-2 instance (the ch2 level-1 drops are also 'max', hence the level filter).
    expect(lvlCount(r.data.save, 'max', 2)).toBe(1);
    // Stat is recomputed as the finale-count of cleared: ch1 finale (seeded) + ch2 finale (just cleared) = 2.
    expect(r.data.save.stats['campaign.chaptersCleared']).toBe(2);
    const anchor = (Object.values(r.data.save.cardInv) as Array<{ defId: string; level: number; sourceType?: string }>)
      .find((c) => c.defId === 'max' && c.level === 2);
    expect(anchor?.sourceType).toBe('pve_anchor:ch2');
  });

  it('later chapter drops higher-tier card (CC-2): ch3 drops a shieldbearer card into the roster', async () => {
    // Unlock ch3_lv1 (prerequisite: ch2_lv10).
    const upto = ['ch1_lv1'];
    for (let c = 1; c <= 2; c++) for (let l = 1; l <= 10; l++) upto.push(`ch${c}_lv${l}`);
    await seedCleared(upto);
    const r = body(await clear('ch3_lv1', 3)); // ch3 → shieldbearer T2 x1
    expect(r.data.grantedCards).toEqual({ 'shieldbearer:2': 1 });
    // Drop tier (T2 in the cardKey) is informational; the Hero Roster grants a fresh level-1 shieldbearer (= chenshou) instance.
    expect(defCount(r.data.save, 'chenshou')).toBe(2); // starter + drop
    const dropped = (Object.values(r.data.save.cardInv) as Array<{ defId: string; sourceType?: string }>)
      .filter((c) => c.defId === 'chenshou');
    expect(dropped.some((c) => c.sourceType === 'pve_drop:ch3_lv1')).toBe(true);
  });

  it('daily cap: when capped neither materials nor unit cards are granted (CC-2)', async () => {
    for (let i = 0; i < PVE_DAILY_CLEAR_REWARD_CAP; i++) await clear('ch1_lv1', 2);
    const capped = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    const lichuangAtCap = defCount(capped.data.save, 'lichuang'); // 1 starter + CAP drops
    expect(lichuangAtCap).toBe(PVE_DAILY_CLEAR_REWARD_CAP + 1);
    const over = body(await clear('ch1_lv1', 2));
    expect(over.data.capped).toBe(true);
    expect(over.data.granted).toEqual({});
    expect(over.data.grantedCards).toEqual({});
    expect(defCount(over.data.save, 'lichuang')).toBe(lichuangAtCap); // over-cap clear grants no card
  });

  it('locked level (prerequisite not cleared) → 400', async () => {
    const res = await clear('ch1_lv2', 3); // ch1_lv1 must be cleared first
    expect(res.statusCode).toBe(400);
  });

  it('repeatable farming: materials granted on every clear (stars take max, never regress)', async () => {
    await clear('ch1_lv1', 3);
    const r2 = body(await clear('ch1_lv1', 1)); // replay with fewer stars
    expect(r2.data.granted).toEqual({ scrap: 6, lead: 2 }); // materials still granted
    expect(r2.data.save.materials.scrap).toBe(12);
    expect(r2.data.save.progress.stars['ch1_lv1']).toBe(3); // stars do not regress
  });

  it('equipment drop stamps provenance sourceType="pve_drop:<levelId>" (ITEM_IDENTITY_DESIGN.md, 2026-08-04)', async () => {
    // ch1_lv5 has equipmentDrop: {rarity:'common', rate:0.10} (pveRewards.ts) — force the roll to hit by
    // stubbing Math.random (prepareClearReward's `Math.random() < dropCfg.rate` gate), independent of the
    // deterministic per-instance seededRng used for slot/affix selection.
    await seedCleared(['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4']);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const before = Date.now();
      const r = body(await clear('ch1_lv5', 3));
      const after = Date.now();
      expect(r.data.grantedEquipment).toBeTruthy();
      expect(r.data.grantedEquipment.rarity).toBe('common');
      expect(r.data.grantedEquipment.sourceType).toBe('pve_drop:ch1_lv5');
      expect(r.data.grantedEquipment.obtainedAt).toBeGreaterThanOrEqual(before);
      expect(r.data.grantedEquipment.obtainedAt).toBeLessThanOrEqual(after);
      // Round-trips through the equipmentInstances collection, not just the mutation response.
      const stored = (await m.collections.equipmentInstances.findOne({ _id: r.data.grantedEquipment.id }))!;
      expect(stored.sourceType).toBe('pve_drop:ch1_lv5');
      expect(stored.obtainedAt).toBe(r.data.grantedEquipment.obtainedAt);
    } finally {
      spy.mockRestore();
    }
  });

  it('daily cap: clears beyond cap are capped and grant no materials (progress still recorded)', async () => {
    for (let i = 0; i < PVE_DAILY_CLEAR_REWARD_CAP; i++) {
      const r = body(await clear('ch1_lv1', 2));
      expect(r.data.capped).toBe(false);
    }
    const over = body(await clear('ch1_lv1', 2));
    expect(over.data.capped).toBe(true);
    expect(over.data.granted).toEqual({});
    expect(over.data.save.materials.scrap).toBe(6 * PVE_DAILY_CLEAR_REWARD_CAP); // not incremented further
  });

  it('achievement stat (S9-3): clearing a chapter final level increments campaign.chaptersCleared (only on first clear, replays do not increment)', async () => {
    // Clear non-final level: chapter stat does not increment (lazy creation by default, stats not instantiated).
    const r1 = body(await clear('ch1_lv1', 3));
    expect(r1.data.save.stats?.['campaign.chaptersCleared'] ?? 0).toBe(0);

    // Seed first 9 levels of ch1 to unlock the final level → clear ch1_lv10 → chapter count +1.
    await seedCleared([
      'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5',
      'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9',
    ]);
    const r2 = body(await clear('ch1_lv10', 3));
    expect(r2.data.save.stats['campaign.chaptersCleared']).toBe(1);

    // Replay already-cleared final level: stat neither regresses nor increments again ($max + first-clear semantics).
    const r3 = body(await clear('ch1_lv10', 1));
    expect(r3.data.save.stats['campaign.chaptersCleared']).toBe(1);

    // Clear second chapter final level → +1 = 2.
    await seedCleared([
      ...r3.data.save.progress.cleared,
      'ch2_lv1', 'ch2_lv2', 'ch2_lv3', 'ch2_lv4', 'ch2_lv5',
      'ch2_lv6', 'ch2_lv7', 'ch2_lv8', 'ch2_lv9',
    ]);
    const r4 = body(await clear('ch2_lv10', 2));
    expect(r4.data.save.stats['campaign.chaptersCleared']).toBe(2);
  });
});

// S9-3b PvE achievement feed: judge re-computation returns kill/cast (verdict.statsJson) → /pve/verify accumulates into stats when verified.
// Requires injecting a fake judge that is "available + configurable verdict" to trigger sampling + re-computation (first clear always triggers sampling → needsReplay → verify).
describe.skipIf(!mongo)('pve achievement feed (S9-3b) e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const seedCleared = (cleared: string[]) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': cleared } });
  /** Mutable verdict: each test case sets `verdict` to configure the fake judge's return value (including statsJson). */
  let verdict: JudgeRes = { ok: true, stars: 3, statsJson: '{}' };
  const fakeGateway: GatewayClient = {
    available: true,
    judge: async () => verdict,
    push: async () => {},
  };
  const clear = (levelId: string, stars = 3) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars } });
  const verify = (verifyId: string) =>
    app.inject({ method: 'POST', url: '/pve/verify', headers: auth(), payload: { verifyId, frames: [], endFrame: 0 } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway: fakeGateway });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-feed-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); });

  it('chapter clear exclusive reward (§4): granted on the spot-check path (needsReplay), not deferred to /pve/verify', async () => {
    verdict = { ok: true, stars: 3, statsJson: '{}' };
    // Seed ch1 lv1..lv9 so ch1_lv10 is a first clear (isFirstClear → always sampled with the fake judge available).
    await seedCleared(['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9']);
    const c = body(await clear('ch1_lv10', 3));
    expect(c.data.needsReplay).toBe(true);
    expect(c.data.granted).toEqual({}); // farmable material reward withheld until re-simulation
    // The one-time chapter card is delivered alongside progress (like campaign.chaptersCleared), not withheld:
    const lv2 = Object.values(c.data.save.cardInv as Record<string, { defId: string; level: number }>)
      .filter((x) => x.defId === 'lichuang' && x.level === 2).length;
    expect(lv2).toBe(1);
    expect(c.data.save.stats['campaign.chaptersCleared']).toBe(1);
  });

  it('judge verified: kill/cast accumulated into lifetime stats + materials granted normally', async () => {
    verdict = { ok: true, stars: 3, statsJson: '{"kill.archer":4,"cast.meteor":2}' };
    // First clear → always sampled → materials not yet granted, returns needsReplay + verifyId.
    const c = body(await clear('ch1_lv1', 3));
    expect(c.data.needsReplay).toBe(true);
    expect(c.data.granted).toEqual({});
    expect(c.data.save.stats?.['kill.archer'] ?? 0).toBe(0); // not credited before re-computation

    const v = body(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 }); // re-computation passed → grant materials
    expect(v.data.save.stats['kill.archer']).toBe(4);
    expect(v.data.save.stats['cast.meteor']).toBe(2);
    expect(v.data.save.stats['kill.guard'] ?? 0).toBe(0); // absent entries not written
  });

  it('L1 out-of-bounds (colluding judge to inflate stats): entire batch rejected, but materials still granted + verified', async () => {
    verdict = { ok: true, stars: 3, statsJson: '{"kill.archer":9999,"cast.meteor":1}' }; // 9999 > cap 200
    const c = body(await clear('ch1_lv1', 3));
    const v = body(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 }); // feed failure does not block material grant
    expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0); // out-of-bounds → entire batch discarded
    expect(v.data.save.stats?.['cast.meteor'] ?? 0).toBe(0);
  });

  it('benefit-of-doubt (judge cannot adjudicate ok:false): grant materials but do not feed stats (non-authoritative re-computation)', async () => {
    verdict = { ok: false }; // no candidate / re-computation failed → unverified, materials still granted (do not penalize honest players) but not fed
    const c = body(await clear('ch1_lv1', 3));
    const v = body(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true); // existing contract: verified = not flagged as suspicious (including benefit-of-doubt), materials still granted
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0); // critical: non-authoritative re-computation → never credited (status!=='verified')
  });

  it('rejected (re-computed stars < claimed): flagged as suspicious, no materials and no stats feed', async () => {
    verdict = { ok: true, stars: 1, statsJson: '{"kill.archer":4}' }; // re-computed 1 star < claimed 3 stars
    const c = body(await clear('ch1_lv1', 3));
    const v = body(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(false);
    expect(v.data.granted).toEqual({});
    expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
  });
});
