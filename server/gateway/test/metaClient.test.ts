// MetaClient unit tests (M17, previously 69.6% — only getElo's happy/degraded paths were incidentally
// exercised via gateway-routing.test.ts's FakeMeta subclass overrides, which never call through to the
// real HTTP methods at all). Covers every method's available/success/degraded-on-failure branches directly
// against the real fetch-based implementation, mocking globalThis.fetch (same convention as
// matchsvcClient.test.ts/socialsvcClient.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { INITIAL_ELO } from '@nw/shared';
import { MetaClient } from '../src/metaClient';

const KEY = 'test-internal-key';
const BASE = 'http://meta:18080';

function installOk(body: unknown): { url: string; key: string | undefined }[] {
  const calls: { url: string; key: string | undefined }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), key: headers['x-internal-key'] });
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}
function installFail(status = 500): void {
  globalThis.fetch = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }) as Response) as typeof fetch;
}

describe('MetaClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('available reflects whether baseUrl is configured', () => {
    expect(new MetaClient(BASE, KEY).available).toBe(true);
    expect(new MetaClient(null, KEY).available).toBe(false);
  });

  describe('getElo', () => {
    it('not configured -> INITIAL_ELO, no request sent', async () => {
      const calls = installOk({});
      expect(await new MetaClient(null, KEY).getElo('acc-a')).toEqual({ elo: INITIAL_ELO });
      expect(calls).toEqual([]);
    });
    it('success -> the fetched elo, hits /internal/elo with accountId + internal key', async () => {
      const calls = installOk({ elo: 1500 });
      expect(await new MetaClient(BASE, KEY).getElo('acc-a')).toEqual({ elo: 1500 });
      expect(calls).toEqual([{ url: `${BASE}/internal/elo?accountId=acc-a`, key: KEY }]);
    });
    it('meta unreachable -> degrades to INITIAL_ELO', async () => {
      installFail();
      expect(await new MetaClient(BASE, KEY).getElo('acc-a')).toEqual({ elo: INITIAL_ELO });
    });
    it('response body missing/non-numeric elo -> degrades to INITIAL_ELO', async () => {
      installOk({});
      expect(await new MetaClient(BASE, KEY).getElo('acc-a')).toEqual({ elo: INITIAL_ELO });
    });
  });

  describe('getProfile', () => {
    it('not configured -> empty object, no request sent', async () => {
      const calls = installOk({});
      expect(await new MetaClient(null, KEY).getProfile('acc-a')).toEqual({});
      expect(calls).toEqual([]);
    });
    it('success -> the fetched profile fields', async () => {
      const calls = installOk({ displayName: 'Alice', publicId: '100000001', equippedTitle: 'champion', avatarId: 'av1' });
      expect(await new MetaClient(BASE, KEY).getProfile('acc-a')).toEqual({ displayName: 'Alice', publicId: '100000001', equippedTitle: 'champion', avatarId: 'av1' });
      expect(calls).toEqual([{ url: `${BASE}/internal/profile?accountId=acc-a`, key: KEY }]);
    });
    it('meta unreachable -> degrades to empty object', async () => {
      installFail();
      expect(await new MetaClient(BASE, KEY).getProfile('acc-a')).toEqual({});
    });
  });

  describe('getMatchIdentity', () => {
    it('not configured -> INITIAL_ELO only, no request sent', async () => {
      const calls = installOk({});
      expect(await new MetaClient(null, KEY).getMatchIdentity('acc-a')).toEqual({ elo: INITIAL_ELO });
      expect(calls).toEqual([]);
    });
    it('success -> full merged elo+profile, optional fields omitted when falsy/empty', async () => {
      const calls = installOk({ elo: 1600, displayName: 'Alice', publicId: '100000001', equippedSkins: ['skin_e1'] });
      expect(await new MetaClient(BASE, KEY).getMatchIdentity('acc-a')).toEqual({ elo: 1600, displayName: 'Alice', publicId: '100000001', equippedSkins: ['skin_e1'] });
      expect(calls).toEqual([{ url: `${BASE}/internal/player?accountId=acc-a`, key: KEY }]);
    });
    it('empty equippedSkins array is omitted, not included as []', async () => {
      installOk({ elo: 1600, equippedSkins: [] });
      const identity = await new MetaClient(BASE, KEY).getMatchIdentity('acc-a');
      expect(identity).not.toHaveProperty('equippedSkins');
    });
    it('meta unreachable -> degrades to INITIAL_ELO only', async () => {
      installFail();
      expect(await new MetaClient(BASE, KEY).getMatchIdentity('acc-a')).toEqual({ elo: INITIAL_ELO });
    });
  });

  describe('resolveByPublicId', () => {
    it('not configured -> null, no request sent', async () => {
      const calls = installOk({});
      expect(await new MetaClient(null, KEY).resolveByPublicId('100000001')).toBeNull();
      expect(calls).toEqual([]);
    });
    it('found -> the resolved accountId', async () => {
      const calls = installOk({ accountId: 'acc-a' });
      expect(await new MetaClient(BASE, KEY).resolveByPublicId('100000001')).toEqual({ accountId: 'acc-a' });
      expect(calls).toEqual([{ url: `${BASE}/internal/account/by-public-id/100000001`, key: KEY }]);
    });
    it('not found (ok but no accountId in body) -> null', async () => {
      installOk({});
      expect(await new MetaClient(BASE, KEY).resolveByPublicId('999999999')).toBeNull();
    });
    it('meta unreachable -> null', async () => {
      installFail();
      expect(await new MetaClient(BASE, KEY).resolveByPublicId('100000001')).toBeNull();
    });
  });

  describe('getFriends', () => {
    it('not configured -> empty array, no request sent', async () => {
      const calls = installOk({});
      expect(await new MetaClient(null, KEY).getFriends('acc-a')).toEqual([]);
      expect(calls).toEqual([]);
    });
    it('success -> the fetched friend accountId list', async () => {
      const calls = installOk({ friends: ['acc-b', 'acc-c'] });
      expect(await new MetaClient(BASE, KEY).getFriends('acc-a')).toEqual(['acc-b', 'acc-c']);
      expect(calls).toEqual([{ url: `${BASE}/internal/social/friends?accountId=acc-a`, key: KEY }]);
    });
    it('response body missing/non-array friends -> empty array', async () => {
      installOk({});
      expect(await new MetaClient(BASE, KEY).getFriends('acc-a')).toEqual([]);
    });
    it('meta unreachable -> empty array', async () => {
      installFail();
      expect(await new MetaClient(BASE, KEY).getFriends('acc-a')).toEqual([]);
    });
  });
});
