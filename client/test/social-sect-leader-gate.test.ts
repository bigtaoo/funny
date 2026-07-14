// Regression test for the "族长无法创建帮会" bug (14.07.2026).
//
// Root cause: loadSLGStatus() derived `isLeader` from
//   platform.storage.getItem('nw_account_id')
// but that storage key is NEVER written anywhere in the client — it has been a phantom
// read since the first SLG commit. So `myAccountId` was always '' and `isLeader` was always
// false, meaning a family leader never saw the "Create sect" button (orgForm gates it on
// s.isLeader). Fixed by reading the authoritative cloud-save identity `saveManager.get().accountId`
// — the same source the app itself uses on relaunch (auth.ts resolveEntry).
//
// This test pins that a leader whose save.accountId matches the family's leaderId is reported
// as isLeader:true, and a non-leader member is not — driving the REAL createSocialNav.loadSLGStatus.
import { describe, it, expect, afterEach } from 'vitest';
import { createSocialNav } from '../src/app/nav/social';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FriendsSceneCallbacks } from '../src/scenes/FriendsScene';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function buildCtx(accountId: string): { ctx: AppCtx; getCb: () => FriendsSceneCallbacks } {
  let capturedCb: FriendsSceneCallbacks | null = null;
  const storage = {
    // 'nw_account_id' intentionally absent — this reproduces the real environment where the
    // phantom key is never written; the fix must not depend on it.
    getItem: (): string | null => null,
    setItem: (): void => {},
    removeItem: (): void => {},
  };
  const views = {
    showFriends: (cb: FriendsSceneCallbacks) => {
      capturedCb = cb;
      return {
        applyFriendPresence() {}, applyFriendRequest() {}, applyFriendUpdate() {},
        applyChatMessage() {}, applyMailNew() {},
      };
    },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: { storage } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as AppCtx['api'],
    baseUrl: null,
    saveManager: { get: () => ({ accountId, wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: {} as unknown as AppState,
    nav: {} as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'Tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return { ctx, getCb: () => { if (!capturedCb) throw new Error('views.showFriends was not called'); return capturedCb; } };
}

/** Mock the world-shard resolve + family lookup; family/mine returns a family led by `leaderId`. */
function mockFetch(leaderId: string): void {
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.includes('/world/active-season')) return jsonResponse({ ok: true, data: { season: 1 } });
    if (url.includes('/world/season/resolve')) return jsonResponse({ ok: true, data: { worldId: 'world:1:0' } });
    if (url.includes('/social/family/mine')) {
      return jsonResponse({ ok: true, data: {
        familyId: 'fam:IDN', name: 'Indonesia', tag: 'IDN', leaderId,
        memberCount: 1, prosperity: 0, members: [{ accountId: leaderId, role: 'leader', joinedAt: 0 }],
      } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('regression: sect-create gate derives isLeader from save.accountId, not the phantom nw_account_id key', () => {
  it('reports isLeader:true when save.accountId matches the family leaderId', async () => {
    mockFetch('acct_leader_1');
    const { ctx, getCb } = buildCtx('acct_leader_1');
    createSocialNav(ctx).goFriends();
    const status = await getCb().loadSLGStatus?.();

    expect(status?.familyId).toBe('fam:IDN');
    // The whole point: a family leader must be recognised so orgForm shows "Create sect".
    expect(status?.isLeader).toBe(true);
  });

  it('reports isLeader:false for a non-leader member (accountId differs from leaderId)', async () => {
    mockFetch('acct_leader_1');
    const { ctx, getCb } = buildCtx('acct_member_2');
    createSocialNav(ctx).goFriends();
    const status = await getCb().loadSLGStatus?.();

    expect(status?.familyId).toBe('fam:IDN');
    expect(status?.isLeader).toBe(false);
  });

  it('reports isLeader:false when the save has no accountId (offline / not yet obtained)', async () => {
    mockFetch('acct_leader_1');
    const { ctx, getCb } = buildCtx('');
    createSocialNav(ctx).goFriends();
    const status = await getCb().loadSLGStatus?.();

    // An empty accountId must never accidentally match an empty leaderId or short-circuit to leader.
    expect(status?.isLeader).toBe(false);
  });
});
