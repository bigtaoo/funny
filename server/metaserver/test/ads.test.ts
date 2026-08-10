// C2: Ad reward server-side validation tests.
// Unit-level: adsGate helpers (hashAdToken/recordAdToken/checkAdInterval/peekAdsStatus/bumpAdsCap) and
//   verifyAdPlatformToken (client-supplied adToken HMAC check for admob_client/wechat_client).
// Route-level (registerAdCallbackRoutes, bare Fastify + fastify.inject, no real Mongo/Redis):
//   GET  /ads/callback/admob  — AdMob SSV: ECDSA-P256 signature over the query string, public key fetched
//     from gstatic (mocked here with a locally generated test key pair) and cached; covers valid/tampered
//     signature, each missing required param, an unknown key_id, a fetch failure (must reject, not 500),
//     and transaction_id replay (idempotent, single commercial.adsCredit call).
//   POST /ads/callback/wechat — WeChat Ads SSV: HMAC-SHA256(NW_WECHAT_ADS_KEY) over sorted params; covers
//     valid/tampered signature, missing fields, an unconfigured secret (503), and trans_id replay.
//   Both routes assert the downstream commercial.adsCredit side effect actually fires on success and does
//   NOT fire on any rejection path.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeNewSave, ADS_REWARD_COINS, type Collections, type SaveData } from '@nw/shared';
import { hashAdToken, recordAdToken, checkAdInterval, peekAdsStatus, bumpAdsCap } from '../src/economy.js';
import { verifyAdPlatformToken, registerAdCallbackRoutes } from '../src/ads.js';
import type { CommercialClient } from '../src/commercialClient.js';
import { FakeCollection } from './helpers/fakeCollection.js';

// ── token uniqueness ──────────────────────────────────────────────────────────────

describe('hashAdToken', () => {
  it('same input → same hash', () => {
    expect(hashAdToken('tx-abc')).toBe(hashAdToken('tx-abc'));
  });
  it('different input → different hash', () => {
    expect(hashAdToken('tx-1')).not.toBe(hashAdToken('tx-2'));
  });
  it('returns 64-char hex', () => {
    expect(hashAdToken('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recordAdToken', () => {
  function makeCol() {
    const store = new Set<string>();
    return {
      insertOne: vi.fn(async (doc: { _id: string }) => {
        if (store.has(doc._id)) throw Object.assign(new Error('dup key'), { code: 11000 });
        store.add(doc._id);
        return {};
      }),
    } as unknown as Parameters<typeof recordAdToken>[0]['adsTokens'] extends infer T ? { adsTokens: T } : never;
  }

  it('first call returns true', async () => {
    const cols = { adsTokens: makeCol() } as Parameters<typeof recordAdToken>[0];
    expect(await recordAdToken(cols, 'hash1', 'acc1', 1000)).toBe(true);
  });

  it('duplicate hash returns false (replay)', async () => {
    const cols = { adsTokens: makeCol() } as Parameters<typeof recordAdToken>[0];
    await recordAdToken(cols, 'hash1', 'acc1', 1000);
    expect(await recordAdToken(cols, 'hash1', 'acc2', 2000)).toBe(false);
  });

  it('different hashes both succeed', async () => {
    const cols = { adsTokens: makeCol() } as Parameters<typeof recordAdToken>[0];
    expect(await recordAdToken(cols, 'hashA', 'acc1', 1000)).toBe(true);
    expect(await recordAdToken(cols, 'hashB', 'acc1', 2000)).toBe(true);
  });
});

// ── 30-min interval gate ─────────────────────────────────────────────────────────────
// checkAdInterval/peekAdsStatus are Redis-backed (2026-07-27, moved off Mongo's adsDaily — see
// shared/src/dailyCounter.ts). Passing redis=null here exercises the same in-process fallback that
// production uses whenever Redis is unconfigured/unreachable — a real counter, not a stub of one, since
// metaserver runs as a single instance anyway (see dailyCounter.ts's module doc comment).

describe('checkAdInterval', () => {
  const INTERVAL = 30 * 60 * 1000; // 30min

  it('first call (no lastAdAt) always passes', async () => {
    expect(await checkAdInterval(null, `acc-first-${Math.random()}`, '2026-06-22', 1000, INTERVAL)).toBe(true);
  });

  it('second call within 30min fails', async () => {
    const acc = `acc-within-${Math.random()}`;
    const base = Date.now();
    await checkAdInterval(null, acc, '2026-06-22', base, INTERVAL);
    expect(await checkAdInterval(null, acc, '2026-06-22', base + 10 * 60 * 1000, INTERVAL)).toBe(false);
  });

  it('second call after 30min passes', async () => {
    const acc = `acc-after-${Math.random()}`;
    const base = 1_000_000;
    await checkAdInterval(null, acc, '2026-06-22', base, INTERVAL);
    expect(await checkAdInterval(null, acc, '2026-06-22', base + INTERVAL + 1, INTERVAL)).toBe(true);
  });
});

// ── peekAdsStatus (read-only status for GET /retention, DailyScene "Ads" tab) ────────────

describe('peekAdsStatus', () => {
  it('no doc yet (never watched today) → watchedToday 0, available now', async () => {
    const r = await peekAdsStatus(null, `acc-fresh-${Math.random()}`, '2026-06-22', 10 * 60 * 1000, 1_000_000);
    expect(r).toEqual({ watchedToday: 0, nextAvailableAt: 0 });
  });

  it('watched, still cooling down → nextAvailableAt in the future', async () => {
    const acc = `acc-cooling-${Math.random()}`;
    await bumpAdsCap(null, acc, '2026-06-22', 5);
    await bumpAdsCap(null, acc, '2026-06-22', 5);
    await checkAdInterval(null, acc, '2026-06-22', 1_000_000, 10 * 60 * 1000);
    const r = await peekAdsStatus(null, acc, '2026-06-22', 10 * 60 * 1000, 1_000_000 + 60_000);
    expect(r.watchedToday).toBe(2);
    expect(r.nextAvailableAt).toBe(1_000_000 + 10 * 60 * 1000);
  });

  it('watched, cooldown already elapsed → nextAvailableAt is 0 (available now)', async () => {
    const acc = `acc-elapsed-${Math.random()}`;
    await bumpAdsCap(null, acc, '2026-06-22', 5);
    await bumpAdsCap(null, acc, '2026-06-22', 5);
    await bumpAdsCap(null, acc, '2026-06-22', 5);
    await checkAdInterval(null, acc, '2026-06-22', 1_000_000, 10 * 60 * 1000);
    const r = await peekAdsStatus(null, acc, '2026-06-22', 10 * 60 * 1000, 1_000_000 + 11 * 60 * 1000);
    expect(r).toEqual({ watchedToday: 3, nextAvailableAt: 0 });
  });
});

// ── bumpAdsCap (daily cap) ───────────────────────────────────────────────────────────

describe('bumpAdsCap', () => {
  it('allows up to cap, denies the next one', async () => {
    const acc = `acc-cap-${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(await bumpAdsCap(null, acc, '2026-06-22', 5)).toBe(true);
    expect(await bumpAdsCap(null, acc, '2026-06-22', 5)).toBe(false);
  });

  it('different dayKey resets the cap', async () => {
    const acc = `acc-daykey-${Math.random()}`;
    for (let i = 0; i < 5; i++) await bumpAdsCap(null, acc, '2026-06-22', 5);
    expect(await bumpAdsCap(null, acc, '2026-06-22', 5)).toBe(false);
    expect(await bumpAdsCap(null, acc, '2026-06-23', 5)).toBe(true);
  });
});

// ── platform token signature verification ─────────────────────────────────────────────────────────────

describe('verifyAdPlatformToken', () => {
  afterEach(() => {
    delete process.env.NW_ADMOB_CLIENT_KEY;
    delete process.env.NW_WECHAT_ADS_CLIENT_KEY;
  });

  it('admob_client: no key → true (fallback pass-through)', () => {
    expect(verifyAdPlatformToken('admob_client', 'anything')).toBe(true);
  });

  it('admob_client: valid HMAC → true', () => {
    process.env.NW_ADMOB_CLIENT_KEY = 'secret';
    const transId = 'tx-google-123';
    const sig = createHmac('sha256', 'secret').update(transId).digest('hex');
    expect(verifyAdPlatformToken('admob_client', `${transId}:${sig}`)).toBe(true);
  });

  it('admob_client: wrong sig → false', () => {
    process.env.NW_ADMOB_CLIENT_KEY = 'secret';
    expect(verifyAdPlatformToken('admob_client', 'tx-123:badhash')).toBe(false);
  });

  it('admob_client: malformed token (no colon) → false', () => {
    process.env.NW_ADMOB_CLIENT_KEY = 'secret';
    expect(verifyAdPlatformToken('admob_client', 'nocolon')).toBe(false);
  });

  it('wechat_client: valid HMAC → true', () => {
    process.env.NW_WECHAT_ADS_CLIENT_KEY = 'wxkey';
    const transId = 'wxtx-456';
    const sig = createHmac('sha256', 'wxkey').update(transId).digest('hex');
    expect(verifyAdPlatformToken('wechat_client', `${transId}:${sig}`)).toBe(true);
  });

  it('wechat_client: invalid sig → false', () => {
    process.env.NW_WECHAT_ADS_CLIENT_KEY = 'wxkey';
    expect(verifyAdPlatformToken('wechat_client', 'wxtx-456:wrong')).toBe(false);
  });

  it('unknown platform → false', () => {
    expect(verifyAdPlatformToken('unknown', 'anything')).toBe(false);
  });
});

// ── registerAdCallbackRoutes: shared test fixtures ───────────────────────────────────────────────
// Bare Fastify + fastify.inject, in-memory fake cols (no Mongo) — same style as internal-economy.test.ts.
// redis=null exercises the real in-process dailyCounter fallback (see checkAdInterval block above),
// which is exactly what a single-instance metaserver does when Redis isn't configured.

interface SaveDocRow { _id: string; save: SaveData; rev: number }
interface AdsTokenRow { _id: string; accountId: string; ts: number; expireAt: Date }

function saveRow(id: string): SaveDocRow {
  const s = makeNewSave(id, 1000);
  return { _id: id, save: s, rev: s.rev };
}

/** Fake CommercialClient exposing only adsCredit (the sole method registerAdCallbackRoutes calls),
 *  tracking every call and a per-account running balance so mirrorCoins' write-back is observable. */
function fakeAdsCommercial() {
  const calls: Array<{ accountId: string; amount: number; dayKey: string }> = [];
  const balances = new Map<string, number>();
  const adsCredit = vi.fn(async (a: { accountId: string; amount: number; dayKey: string }) => {
    calls.push(a);
    const after = (balances.get(a.accountId) ?? 0) + a.amount;
    balances.set(a.accountId, after);
    return { ok: true as const, coinsAfter: after };
  });
  return {
    calls,
    balances,
    fake: { adsCredit } as unknown as CommercialClient,
  };
}

// ── AdMob SSV callback (GET /ads/callback/admob) ─────────────────────────────────────────────────
// verifyAdmobCallback fetches https://gstatic.com/admob/reward/verifier-keys.json (via global fetch) and
// caches the result in a module-level variable for 5min. We stub global.fetch to return a locally
// generated ECDSA-P256 test key pair, and vi.resetModules() + a fresh dynamic import of ads.js before
// every test so that cache never leaks a stale key pair from one test into the next.

describe('registerAdCallbackRoutes: AdMob SSV callback', () => {
  const KEY_ID = 777;

  let ACCOUNT_ID: string;
  let register: typeof registerAdCallbackRoutes;
  let privateKey: KeyObject;
  let publicKeyPem: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;
  let saves: FakeCollection<SaveDocRow>;
  let adsTokens: FakeCollection<AdsTokenRow>;
  let comm: ReturnType<typeof fakeAdsCommercial>;
  const fakeNow = 1_700_000_000_000;

  beforeEach(async () => {
    vi.resetModules();
    ({ registerAdCallbackRoutes: register } = await import('../src/ads.js'));

    // Unique per test: checkAdInterval/bumpAdsCap's redis=null fallback lives in @nw/shared's
    // dailyCounter.ts, a workspace package resolved outside Vitest's module graph — vi.resetModules()
    // above does NOT clear it (confirmed empirically: a shared accountId across tests at the same fakeNow
    // tripped the real 10min interval gate on the second successful test, both of which report the exact
    // same "cap reached" string as an actual cap hit — see checkAdInterval/bumpAdsCap gating in ads.ts).
    ACCOUNT_ID = `acc-admob-${Math.random()}`;

    const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;

    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ keys: [{ keyId: KEY_ID, pem: publicKeyPem }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    saves = new FakeCollection<SaveDocRow>().seed(saveRow(ACCOUNT_ID));
    adsTokens = new FakeCollection<AdsTokenRow>();
    comm = fakeAdsCommercial();

    app = Fastify();
    register(app, {
      cols: { saves, adsTokens } as unknown as Collections,
      commercial: comm.fake,
      now: () => fakeNow,
      redis: null,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  /** Builds a correctly-signed callback URL: signs over `fields` in URLSearchParams order (matching
   *  verifyAdmobCallback's own reconstruction), then appends signature + key_id. */
  function signedUrl(fields: Record<string, string>, opts: { keyId?: number } = {}): string {
    const message = new URLSearchParams(fields).toString();
    const signature = createSign('SHA256').update(message).sign(privateKey, 'base64url');
    const full = new URLSearchParams(fields);
    full.set('signature', signature);
    full.set('key_id', String(opts.keyId ?? KEY_ID));
    return `/ads/callback/admob?${full.toString()}`;
  }

  it('valid signature → 200 OK, credits via commercial.adsCredit, mirrors coins into the save', async () => {
    const url = signedUrl({ transaction_id: 'tx-valid-1', custom_data: ACCOUNT_ID });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('OK');
    expect(comm.calls).toHaveLength(1);
    expect(comm.calls[0]).toMatchObject({ accountId: ACCOUNT_ID, amount: ADS_REWARD_COINS });
    expect(saves.docs.get(ACCOUNT_ID)!.save.wallet.coins).toBe(ADS_REWARD_COINS);
  });

  it('tampered payload after signing → 400 invalid signature, no credit', async () => {
    const url = signedUrl({ transaction_id: 'tx-tamper-1', custom_data: ACCOUNT_ID });
    const tampered = url.replace('tx-tamper-1', 'tx-tamper-1-evil');
    const res = await app.inject({ method: 'GET', url: tampered });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it('missing transaction_id → 400 missing params, never reaches signature verification', async () => {
    const res = await app.inject({ method: 'GET', url: `/ads/callback/admob?custom_data=${ACCOUNT_ID}&signature=x&key_id=${KEY_ID}` });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('missing params');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(comm.calls).toHaveLength(0);
  });

  it('missing signature → 400 missing params', async () => {
    const res = await app.inject({ method: 'GET', url: `/ads/callback/admob?transaction_id=tx-1&custom_data=${ACCOUNT_ID}&key_id=${KEY_ID}` });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('missing params');
    expect(comm.calls).toHaveLength(0);
  });

  it('missing key_id → 400 missing params', async () => {
    const res = await app.inject({ method: 'GET', url: `/ads/callback/admob?transaction_id=tx-1&custom_data=${ACCOUNT_ID}&signature=x` });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('missing params');
    expect(comm.calls).toHaveLength(0);
  });

  it('missing custom_data (and no user_id fallback) → 400 missing params', async () => {
    const res = await app.inject({ method: 'GET', url: `/ads/callback/admob?transaction_id=tx-1&signature=x&key_id=${KEY_ID}` });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('missing params');
    expect(comm.calls).toHaveLength(0);
  });

  it('key_id not present in the fetched key list → rejected, no credit', async () => {
    const url = signedUrl({ transaction_id: 'tx-badkid-1', custom_data: ACCOUNT_ID }, { keyId: KEY_ID + 1 });
    const res = await app.inject({ method: 'GET', url });
    expect(fetchMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it('gstatic key fetch fails (network error) → conservatively rejects with 400, not a 500', async () => {
    fetchMock.mockRejectedValueOnce(new Error('simulated network failure'));
    const url = signedUrl({ transaction_id: 'tx-neterr-1', custom_data: ACCOUNT_ID });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it('replaying the same transaction_id → idempotent 200 "already processed", credited only once', async () => {
    const url = signedUrl({ transaction_id: 'tx-replay-1', custom_data: ACCOUNT_ID });
    const r1 = await app.inject({ method: 'GET', url });
    expect(r1.statusCode).toBe(200);
    expect(r1.payload).toBe('OK');

    const r2 = await app.inject({ method: 'GET', url });
    expect(r2.statusCode).toBe(200);
    expect(r2.payload).toBe('already processed');
    expect(comm.calls).toHaveLength(1);
  });
});

// ── WeChat Ads SSV callback (POST /ads/callback/wechat) ──────────────────────────────────────────
// verifyWechatAdsCallback is a pure HMAC check (no network, no cache) — no module reset needed here.

describe('registerAdCallbackRoutes: WeChat Ads SSV callback', () => {
  const WECHAT_KEY = 'wx-ads-test-secret';

  let OPENID: string;
  let app: FastifyInstance;
  let saves: FakeCollection<SaveDocRow>;
  let adsTokens: FakeCollection<AdsTokenRow>;
  let comm: ReturnType<typeof fakeAdsCommercial>;
  const fakeNow = 1_700_000_000_000;

  /** Signs fields the same way verifyWechatAdsCallback does: sort(nonce,openid,timestamp,trans_id) → k=v joined by & → HMAC-SHA256. */
  function signedBody(fields: { openid: string; trans_id: string; timestamp: number; nonce: string }, key = WECHAT_KEY) {
    const pairs: [string, string][] = [
      ['nonce', fields.nonce],
      ['openid', fields.openid],
      ['timestamp', String(fields.timestamp)],
      ['trans_id', fields.trans_id],
    ];
    pairs.sort(([a], [b]) => a.localeCompare(b));
    const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
    const sign = createHmac('sha256', key).update(message).digest('hex');
    return { ...fields, sign };
  }

  beforeEach(() => {
    process.env.NW_WECHAT_ADS_KEY = WECHAT_KEY;
    // Unique per test — see the matching comment in the AdMob describe block above for why: the
    // interval/cap in-process fallback in @nw/shared's dailyCounter.ts outlives vi.resetModules().
    OPENID = `wx-openid-${Math.random()}`;
    saves = new FakeCollection<SaveDocRow>().seed(saveRow(OPENID));
    adsTokens = new FakeCollection<AdsTokenRow>();
    comm = fakeAdsCommercial();
    app = Fastify();
    registerAdCallbackRoutes(app, {
      cols: { saves, adsTokens } as unknown as Collections,
      commercial: comm.fake,
      now: () => fakeNow,
      redis: null,
    });
  });

  afterEach(async () => {
    delete process.env.NW_WECHAT_ADS_KEY;
    await app.close();
  });

  it('valid signature → 200, credits via commercial.adsCredit using openid as accountId', async () => {
    const body = signedBody({ openid: OPENID, trans_id: 'wxtx-valid-1', timestamp: 1000, nonce: 'n-valid-1' });
    const res = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: body });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ errcode: 0, errmsg: 'ok' });
    expect(comm.calls).toHaveLength(1);
    expect(comm.calls[0]).toMatchObject({ accountId: OPENID, amount: ADS_REWARD_COINS });
    expect(saves.docs.get(OPENID)!.save.wallet.coins).toBe(ADS_REWARD_COINS);
  });

  it('tampered field after signing → 400 invalid signature, no credit', async () => {
    const body = signedBody({ openid: OPENID, trans_id: 'wxtx-tamper-1', timestamp: 1000, nonce: 'n-tamper-1' });
    const tampered = { ...body, trans_id: 'wxtx-tamper-1-evil' };
    const res = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: tampered });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toBe('invalid signature');
    expect(comm.calls).toHaveLength(0);
  });

  it.each(['openid', 'trans_id', 'timestamp', 'nonce', 'sign'] as const)(
    'missing %s → 400 (verifyWechatAdsCallback requires all five fields, so this is reported as an invalid signature)',
    async (field) => {
      const body = signedBody({ openid: OPENID, trans_id: 'wxtx-missing-1', timestamp: 1000, nonce: 'n-missing-1' });
      const incomplete = { ...body } as Record<string, unknown>;
      delete incomplete[field];
      const res = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: incomplete });
      expect(res.statusCode).toBe(400);
      expect(comm.calls).toHaveLength(0);
    },
  );

  it('NW_WECHAT_ADS_KEY not configured → 503, no credit', async () => {
    delete process.env.NW_WECHAT_ADS_KEY;
    const body = signedBody({ openid: OPENID, trans_id: 'wxtx-noconf-1', timestamp: 1000, nonce: 'n-noconf-1' });
    const res = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: body });
    expect(res.statusCode).toBe(503);
    expect(comm.calls).toHaveLength(0);
  });

  it('replaying the same trans_id → idempotent 200, credited only once', async () => {
    const body = signedBody({ openid: OPENID, trans_id: 'wxtx-replay-1', timestamp: 1000, nonce: 'n-replay-1' });
    const r1 = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: body });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: 'POST', url: '/ads/callback/wechat', payload: body });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload)).toEqual({ errcode: 0, errmsg: 'ok' });
    expect(comm.calls).toHaveLength(1);
  });
});
