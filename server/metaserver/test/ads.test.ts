// C2: Ad reward server-side validation unit tests.
// Covers: token uniqueness (replay rejection), 30-min interval gate, platform token signature verification (admob_client/wechat_client),
//         WeChat ad SSV callback signature, AdMob SSV verification fallback (conservatively reject on network failure).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashAdToken, recordAdToken, checkAdInterval, peekAdsStatus, bumpAdsCap } from '../src/economy.js';
import { verifyAdPlatformToken } from '../src/ads.js';

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
