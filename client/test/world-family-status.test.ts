// Regression tests for the "family created but client stays in noFamily state" bug.
//
// Root cause: worldsvc's playerWorld.familyId is a join-time-only mirror (SS7, see
// server/worldsvc/src/territory.ts joinWorld) that is written once when a player first
// enters the SLG world and is NEVER updated afterward. Three client call sites used to
// read that stale field (via WorldApiClient.getMe()) to decide "am I in a family?" —
// so creating/joining a family after already having a playerWorld doc left the UI stuck
// showing "not in a family" forever, even though socialsvc had the membership recorded.
//
// Fix: WorldApiClient.getMyFamily() (and listFamilies(), which now delegates to it) hits
// socialsvc's live `/social/family/mine` directly instead of going through worldsvc's mirror.
// These tests pin that contract so a future refactor can't silently reintroduce the stale read.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldApiClient, type FamilyDetailView } from '../src/net/WorldApiClient';

const noopStorage = {
  getItem: (_k: string): string | null => null,
  setItem: (_k: string, _v: string): void => {},
  removeItem: (_k: string): void => {},
};

function setBases(worldBase: string, socialBase: string): void {
  (globalThis as Record<string, unknown>).__NW_WORLD_BASE__ = worldBase;
  (globalThis as Record<string, unknown>).__NW_SOCIAL_BASE__ = socialBase;
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  (globalThis as Record<string, unknown>).fetch = handler;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__NW_WORLD_BASE__;
  delete (globalThis as Record<string, unknown>).__NW_SOCIAL_BASE__;
  delete (globalThis as Record<string, unknown>).fetch;
  vi.restoreAllMocks();
});

const FAM: FamilyDetailView = {
  familyId: 'fam:ABC',
  name: 'Ink Guard',
  tag: 'ABC',
  leaderId: 'acct-leader',
  memberCount: 1,
  prosperity: 0,
  members: [{ accountId: 'acct-leader', role: 'leader', joinedAt: 0 }],
};

describe('WorldApiClient.getMyFamily()', () => {
  it('hits socialsvc GET /social/family/mine (not worldsvc /world/me)', async () => {
    setBases('http://localhost:18084', 'http://localhost:8085');
    let capturedUrl = '';
    stubFetch(async (url) => { capturedUrl = url; return jsonResponse({ ok: true, data: FAM }); });
    const client = new WorldApiClient(noopStorage);

    const fam = await client.getMyFamily();

    expect(capturedUrl).toBe('http://localhost:8085/social/family/mine');
    expect(fam).toEqual(FAM);
  });

  it('returns null when the server reports no membership (data: null), without throwing', async () => {
    setBases('http://localhost:18084', 'http://localhost:8085');
    stubFetch(async () => jsonResponse({ ok: true, data: null }));
    const client = new WorldApiClient(noopStorage);

    expect(await client.getMyFamily()).toBeNull();
  });
});

describe('WorldApiClient.listFamilies() (delegates to getMyFamily)', () => {
  it('wraps the live family into a single-element array', async () => {
    setBases('http://localhost:18084', 'http://localhost:8085');
    stubFetch(async () => jsonResponse({ ok: true, data: FAM }));
    const client = new WorldApiClient(noopStorage);

    expect(await client.listFamilies()).toEqual([FAM]);
  });

  it('returns [] when not in a family', async () => {
    setBases('http://localhost:18084', 'http://localhost:8085');
    stubFetch(async () => jsonResponse({ ok: true, data: null }));
    const client = new WorldApiClient(noopStorage);

    expect(await client.listFamilies()).toEqual([]);
  });
});

describe('regression: family membership must not be derived from getMe()', () => {
  it('getMyFamily() never calls /world/me, even when a playerWorld doc/mirror would be stale', async () => {
    setBases('http://localhost:18084', 'http://localhost:8085');
    const calledPaths: string[] = [];
    stubFetch(async (url) => {
      calledPaths.push(url);
      // Simulate the exact stale-mirror bug: /world/me would report no familyId even
      // though the family was created moments ago and socialsvc already knows about it.
      if (url.includes('/world/me')) return jsonResponse({ ok: true, data: { joined: true, worldId: 'w1' } });
      if (url.includes('/social/family/mine')) return jsonResponse({ ok: true, data: FAM });
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new WorldApiClient(noopStorage);

    const fam = await client.getMyFamily();

    expect(fam).toEqual(FAM);
    expect(calledPaths.some((p) => p.includes('/world/me'))).toBe(false);
  });
});
