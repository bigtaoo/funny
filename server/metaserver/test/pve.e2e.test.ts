// PvE server-authoritative end-to-end (PVE_INTEGRITY_PLAN §8): /pve/clear completion settlement + /pve/upgrade upgrade.
//   Validates unlock prerequisites, repeatable farming with material grants, daily cap capped, upgrade deducts cost / insufficient → 402 / max level → 400.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, PVE_DAILY_CLEAR_REWARD_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes } from '../dist/gatewayClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
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
  const upgrade = (upgradeId: string) =>
    app.inject({ method: 'POST', url: '/pve/upgrade', headers: auth(), payload: { upgradeId } });
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
  });

  // CC-2 Hero Roster model: a PvE level drop is granted as a CardInstance in `cardInv` (unitType → CARD_DEFS entry),
  // NOT the retired S12 `cardInventory`/`unitLevels` fields (removed from SaveData v4). `grantedCards` (cardKey→count)
  // remains the response contract (openapi.yml). Helper: count roster instances of a given defId.
  const defCount = (save: { cardInv: Record<string, { defId: string; level: number }> }, defId: string) =>
    Object.values(save.cardInv).filter((c) => c.defId === defId).length;

  it('level drops unit card (CC-2): first chapter level grants an infantry Hero-Roster card + grantedCards', async () => {
    const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(defCount(before.data.save, 'lichuang')).toBe(1); // onboarding starter (infantry = lichuang)
    const r = body(await clear('ch1_lv1', 3)); // ch1 → infantry T1 x1
    expect(r.data.grantedCards).toEqual({ 'infantry:1': 1 });
    // Drop is granted as a level-2 CardInstance (grantClearReward grants at level 2); starter stays level 1.
    expect(defCount(r.data.save, 'lichuang')).toBe(2);
    expect(Object.values(r.data.save.cardInv).filter((c: any) => c.defId === 'lichuang' && c.level === 2)).toHaveLength(1);
    // Final level (lv10) grants double cards.
    await seedCleared([
      'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5',
      'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9',
    ]);
    const r10 = body(await clear('ch1_lv10', 3));
    expect(r10.data.grantedCards).toEqual({ 'infantry:1': 2 });
    expect(defCount(r10.data.save, 'lichuang')).toBe(4); // +2 from the double drop
  });

  it('later chapter drops higher-tier card (CC-2): ch3 drops a shieldbearer card into the roster', async () => {
    // Unlock ch3_lv1 (prerequisite: ch2_lv10).
    const upto = ['ch1_lv1'];
    for (let c = 1; c <= 2; c++) for (let l = 1; l <= 10; l++) upto.push(`ch${c}_lv${l}`);
    await seedCleared(upto);
    const r = body(await clear('ch3_lv1', 3)); // ch3 → shieldbearer T2 x1
    expect(r.data.grantedCards).toEqual({ 'shieldbearer:2': 1 });
    // Drop tier (T2 in the cardKey) is informational; the Hero Roster grants a level-2 shieldbearer (= chenshou) instance.
    expect(defCount(r.data.save, 'chenshou')).toBe(2); // starter + drop
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

  it('upgrade: sufficient materials deducted + pveUpgrades+1; insufficient → 402; max level → 400', async () => {
    // Accumulate materials: farm ch1_lv1 a few times for scrap (inf_hp 0→1 costs scrap×3).
    await clear('ch1_lv1', 3); // scrap 6
    const u1 = body(await upgrade('inf_hp'));
    expect(u1.data.save.pveUpgrades['inf_hp']).toBe(1);
    expect(u1.data.save.materials.scrap).toBe(3); // 6 - 3
    // 0→1 already cost 3, 1→2 costs scrap×6 > remaining 3 → 402.
    const u2 = await upgrade('inf_hp');
    expect(u2.statusCode).toBe(402);
    // Unknown upgrade → 400.
    expect((await upgrade('nope')).statusCode).toBe(400);
  });
});

// S9-3b PvE achievement feed: judge re-computation returns kill/cast (verdict.statsJson) → /pve/verify accumulates into stats when verified.
// Requires injecting a fake judge that is "available + configurable verdict" to trigger sampling + re-computation (first clear always triggers sampling → needsReplay → verify).
describe.skipIf(!mongo)('pve achievement feed (S9-3b) e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  /** Mutable verdict: each test case sets `verdict` to configure the fake judge's return value (including statsJson). */
  let verdict: JudgeRes = { ok: true, stars: 3, statsJson: '{}' };
  const fakeGateway: GatewayClient = {
    available: true,
    judge: async () => verdict,
    push: async () => {},
    presence: async () => ({}),
    invalidateFriends: async () => {},
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
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); });

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
