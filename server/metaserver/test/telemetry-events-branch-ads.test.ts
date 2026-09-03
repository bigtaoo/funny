// Branch-coverage backfill for src/ads.ts (group D, 2026-09-03).
//
// test/ads.test.ts covers the signature-verification matrix thoroughly; what it never sends is a
// *degraded platform*: a gstatic key endpoint answering non-2xx or with a body that has no `keys` at
// all, a key entry whose PEM does not parse, and — on both callbacks — the two post-verification
// refusals (rate/cap gate and a commercial credit that verifies but declines). Those last two matter
// because both platforms retry any non-200: the branch taken decides whether Google/WeChat stops
// asking or hammers the endpoint forever, and whether the player is credited twice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import { verifyAdPlatformToken, type registerAdCallbackRoutes } from '../src/ads.js';
import type { CommercialClient } from '../src/commercialClient.js';
import { FakeCollection } from './helpers/fakeCollection.js';

interface SaveDocRow { _id: string; save: SaveData; rev: number }
interface AdsTokenRow { _id: string; accountId: string; ts: number; expireAt: Date }

function saveRow(id: string): SaveDocRow {
  const s = makeNewSave(id, 1000);
  return { _id: id, save: s, rev: s.rev };
}

/** Fake commercial exposing only adsCredit, with a seedable failure so the "verified but declined"
 *  branch can be driven (a real decline is e.g. a wallet-service outage or a hard per-day ledger cap). */
function fakeAdsCommercial(fail?: { error: string }) {
  const calls: Array<{ accountId: string; amount: number; dayKey: string }> = [];
  const adsCredit = vi.fn(async (a: { accountId: string; amount: number; dayKey: string }) => {
    calls.push(a);
    return fail ? { ok: false as const, error: fail.error } : { ok: true as const, coinsAfter: a.amount };
  });
  return { calls, fake: { adsCredit } as unknown as CommercialClient };
}

// ── Client-side adToken verification: the wechat_client half nothing had driven ────────────────────
describe('verifyAdPlatformToken (wechat_client, unconfigured / malformed)', () => {
  afterEach(() => { delete process.env.NW_WECHAT_ADS_CLIENT_KEY; });

  it('no NW_WECHAT_ADS_CLIENT_KEY → open fallback (token uniqueness + daily cap are the only guard)', () => {
    // Deliberate: a WeChat deployment that has not been given the secret yet must not lock every player
    // out of ad rewards. The comment in ads.ts states this; nothing tested it for wechat_client.
    expect(verifyAdPlatformToken('wechat_client', 'anything-at-all')).toBe(true);
  });

  it('configured but the token has no `transId:sig` shape → rejected', () => {
    process.env.NW_WECHAT_ADS_CLIENT_KEY = 'wxkey';
    expect(verifyAdPlatformToken('wechat_client', 'nocolon')).toBe(false);
    expect(verifyAdPlatformToken('wechat_client', ':onlysig')).toBe(false);
  });

  it('configured and well-formed still verifies (control for the two rejections above)', () => {
    process.env.NW_WECHAT_ADS_CLIENT_KEY = 'wxkey';
    const transId = 'wxtx-ok';
    const sig = createHmac('sha256', 'wxkey').update(transId).digest('hex');
    expect(verifyAdPlatformToken('wechat_client', `${transId}:${sig}`)).toBe(true);
  });
});

// ── AdMob SSV: a degraded gstatic key endpoint + the post-verification refusals ────────────────────
describe('registerAdCallbackRoutes: AdMob SSV degraded paths', () => {
  const KEY_ID = 909;
  const fakeNow = 1_700_000_000_000;

  let ACCOUNT_ID: string;
  let register: typeof registerAdCallbackRoutes;
  let privateKey: KeyObject;
  let publicKeyPem: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;
  let saves: FakeCollection<SaveDocRow>;
  let adsTokens: FakeCollection<AdsTokenRow>;

  // vi.resetModules() + a fresh import per test: ads.ts caches the fetched key list in a module-level
  // variable for 5 minutes, so a poisoned/empty list from one test would leak into the next.
  beforeEach(async () => {
    vi.resetModules();
    ({ registerAdCallbackRoutes: register } = await import('../src/ads.js'));
    // Unique per test: the redis=null interval/cap fallback lives in @nw/shared's dailyCounter.ts,
    // outside vitest's module graph, so resetModules does not clear it (see ads.test.ts's comment).
    ACCOUNT_ID = `acc-grpD-admob-${Math.random()}`;
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    saves = new FakeCollection<SaveDocRow>().seed(saveRow(ACCOUNT_ID));
    adsTokens = new FakeCollection<AdsTokenRow>();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
  });

  function mount(comm: CommercialClient): void {
    app = Fastify();
    register(app, { cols: { saves, adsTokens } as unknown as Collections, commercial: comm, now: () => fakeNow, redis: null });
  }

  function signedUrl(fields: Record<string, string>): string {
    const message = new URLSearchParams(fields).toString();
    const signature = createSign('SHA256').update(message).sign(privateKey, 'base64url');
    const full = new URLSearchParams(fields);
    full.set('signature', signature);
    full.set('key_id', String(KEY_ID));
    return `/ads/callback/admob?${full.toString()}`;
  }

  it('gstatic answers 500 → rejected as an invalid signature, never credited', async () => {
    // No key list means no way to prove the callback is Google's; the only safe answer is to refuse.
    // A 400 also tells Google to stop retrying, which is what we want while gstatic is broken.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const comm = fakeAdsCommercial();
    mount(comm.fake);
    const res = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-500', custom_data: ACCOUNT_ID }) });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it('gstatic answers 200 with no `keys` field → empty key list, callback rejected', async () => {
    // Same outcome as a 500, but reached through `json.keys ?? []` rather than a throw. Note the
    // consequence, which is why this branch is worth naming: an empty list IS cached for 5 minutes, so
    // one malformed response silently refuses every SSV callback for that window.
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const comm = fakeAdsCommercial();
    mount(comm.fake);
    const first = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-nokeys-1', custom_data: ACCOUNT_ID }) });
    expect(first.statusCode).toBe(400);
    const second = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-nokeys-2', custom_data: ACCOUNT_ID }) });
    expect(second.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the empty list was cached, not re-fetched
    expect(comm.calls).toHaveLength(0);
  });

  it('the matching key entry carries an unparseable PEM → rejected, not a 500', async () => {
    // A corrupted/rotated-format entry makes createVerify throw; swallowing that into `false` keeps a
    // bad key from turning every callback into a 500 (which Google would retry indefinitely).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ keyId: KEY_ID, pem: 'not a pem at all' }] }) })));
    const comm = fakeAdsCommercial();
    mount(comm.fake);
    const res = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-badpem', custom_data: ACCOUNT_ID }) });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it('second valid callback inside the minimum interval → 200 "cap reached", credited only once', async () => {
    // Google retries anything that is not a 200, so the rate/cap refusal must still answer 200 —
    // otherwise a capped player generates an endless retry storm against this endpoint.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ keyId: KEY_ID, pem: publicKeyPem }] }) })));
    const comm = fakeAdsCommercial();
    mount(comm.fake);
    const first = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-cap-1', custom_data: ACCOUNT_ID }) });
    expect(first.payload).toBe('OK');
    const second = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-cap-2', custom_data: ACCOUNT_ID }) });
    expect(second.statusCode).toBe(200);
    expect(second.payload).toBe('cap reached');
    expect(comm.calls).toHaveLength(1);
  });

  it('commercial declines the credit → 200 "credit failed", and no coin mirror is written to the save', async () => {
    // The token was already consumed, so a retry would be reported as "already processed"; the save must
    // therefore be left exactly as it was rather than mirroring a balance that was never granted.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ keyId: KEY_ID, pem: publicKeyPem }] }) })));
    const comm = fakeAdsCommercial({ error: 'WALLET_UNAVAILABLE' });
    mount(comm.fake);
    const res = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-declined', custom_data: ACCOUNT_ID }) });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('credit failed');
    expect(comm.calls).toHaveLength(1);
    expect(saves.docs.get(ACCOUNT_ID)!.save.wallet.coins).toBe(0);
  });

  it('user_id is used when custom_data is absent (the SSV fallback identity)', async () => {
    // custom_data is set by the client before the ad plays; if it never made it, AdMob's own user_id is
    // the only account identity in the callback — dropping it would silently lose the reward.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ keyId: KEY_ID, pem: publicKeyPem }] }) })));
    const comm = fakeAdsCommercial();
    mount(comm.fake);
    const res = await app.inject({ method: 'GET', url: signedUrl({ transaction_id: 'tx-userid', user_id: ACCOUNT_ID }) });
    expect(res.payload).toBe('OK');
    expect(comm.calls[0]).toMatchObject({ accountId: ACCOUNT_ID });
  });
});

// ── WeChat Ads SSV: the same two post-verification refusals ────────────────────────────────────────
describe('registerAdCallbackRoutes: WeChat Ads SSV refusals', () => {
  const WECHAT_KEY = 'wx-ads-grpD-secret';
  const fakeNow = 1_700_000_000_000;

  let OPENID: string;
  let app: FastifyInstance;
  let saves: FakeCollection<SaveDocRow>;
  let adsTokens: FakeCollection<AdsTokenRow>;

  function signedBody(fields: { openid: string; trans_id: string; timestamp: number; nonce: string }) {
    const pairs: [string, string][] = [
      ['nonce', fields.nonce],
      ['openid', fields.openid],
      ['timestamp', String(fields.timestamp)],
      ['trans_id', fields.trans_id],
    ];
    pairs.sort(([a], [b]) => a.localeCompare(b));
    const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
    return { ...fields, sign: createHmac('sha256', WECHAT_KEY).update(message).digest('hex') };
  }

  beforeEach(async () => {
    vi.resetModules();
    process.env.NW_WECHAT_ADS_KEY = WECHAT_KEY;
    OPENID = `wx-grpD-${Math.random()}`;
    saves = new FakeCollection<SaveDocRow>().seed(saveRow(OPENID));
    adsTokens = new FakeCollection<AdsTokenRow>();
  });

  afterEach(async () => {
    delete process.env.NW_WECHAT_ADS_KEY;
    await app?.close();
  });

  async function mount(comm: CommercialClient): Promise<void> {
    const { registerAdCallbackRoutes: register } = await import('../src/ads.js');
    app = Fastify();
    register(app, { cols: { saves, adsTokens } as unknown as Collections, commercial: comm, now: () => fakeNow, redis: null });
  }

  it('second valid callback inside the minimum interval → errcode 0 "cap" (WeChat must not retry)', async () => {
    const comm = fakeAdsCommercial();
    await mount(comm.fake);
    const first = await app.inject({
      method: 'POST', url: '/ads/callback/wechat',
      payload: signedBody({ openid: OPENID, trans_id: 'wx-cap-1', timestamp: 1000, nonce: 'n1' }),
    });
    expect(JSON.parse(first.payload)).toEqual({ errcode: 0, errmsg: 'ok' });
    const second = await app.inject({
      method: 'POST', url: '/ads/callback/wechat',
      payload: signedBody({ openid: OPENID, trans_id: 'wx-cap-2', timestamp: 2000, nonce: 'n2' }),
    });
    expect(second.statusCode).toBe(200);
    // errcode 0 (not 1): the callback was accepted and deliberately not rewarded, so WeChat stops here.
    expect(JSON.parse(second.payload)).toEqual({ errcode: 0, errmsg: 'cap' });
    expect(comm.calls).toHaveLength(1);
  });

  it('commercial declines the credit → errcode 1 carrying the reason, save left unmirrored', async () => {
    // errcode 1 here, unlike the cap refusal: this one really did fail, and the reason string is the
    // only trace of WHY in WeChat's own callback log.
    const comm = fakeAdsCommercial({ error: 'WALLET_UNAVAILABLE' });
    await mount(comm.fake);
    const res = await app.inject({
      method: 'POST', url: '/ads/callback/wechat',
      payload: signedBody({ openid: OPENID, trans_id: 'wx-declined', timestamp: 1000, nonce: 'n3' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ errcode: 1, errmsg: 'WALLET_UNAVAILABLE' });
    expect(saves.docs.get(OPENID)!.save.wallet.coins).toBe(0);
  });
});
