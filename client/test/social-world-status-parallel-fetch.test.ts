// Regression test for the "world chat loading takes 10+ seconds" investigation (14.07.2026).
//
// Root cause (part 2 of 3): loadSLGStatus() used to await ensureWorldId() (season lookup +
// shard resolve, both worldsvc) and THEN await getMyFamily() (socialsvc) — a fully serial
// chain, even though getMyFamily() never depends on the resolved worldId. Fixed by kicking off
// both with Promise.all so they run concurrently.
//
// This test pins that both requests are in flight before either resolves: /social/family/mine
// must be requested before /world/season/resolve responds, proving they overlap rather than
// running one after the other.
import { describe, it, expect, afterEach } from 'vitest';
import { createSocialNav } from '../src/app/nav/social';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FriendsSceneCallbacks } from '../src/scenes/FriendsScene';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function buildCtx(): { ctx: AppCtx; getCb: () => FriendsSceneCallbacks } {
  let capturedCb: FriendsSceneCallbacks | null = null;
  const storage = {
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
    saveManager: { get: () => ({ wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
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

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('regression: loadSLGStatus fetches world-shard resolve and family status concurrently', () => {
  it('/social/family/mine is requested before /world/season/resolve has resolved', async () => {
    const calls: string[] = [];
    let resolveSeasonResolve!: () => void;
    const seasonResolveGate = new Promise<void>((r) => { resolveSeasonResolve = r; });

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      calls.push(url);
      if (url.includes('/world/active-season')) return jsonResponse({ ok: true, data: { season: 1 } });
      if (url.includes('/world/season/resolve')) {
        // Hold the season-resolve response open until /social/family/mine has already
        // been dispatched — this is only possible if the two calls run concurrently.
        await seasonResolveGate;
        return jsonResponse({ ok: true, data: { worldId: 'world:1:0' } });
      }
      if (url.includes('/social/family/mine')) {
        resolveSeasonResolve();
        return jsonResponse({ ok: true, data: null });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    const { ctx, getCb } = buildCtx();
    const { goFriends } = createSocialNav(ctx);
    goFriends();
    const status = await getCb().loadSLGStatus?.();

    expect(status?.worldId).toBe('world:1:0');
    const familyIdx = calls.findIndex((u) => u.includes('/social/family/mine'));
    const resolveIdx = calls.findIndex((u) => u.includes('/world/season/resolve'));
    // Both were dispatched before either finished — family/mine's handler unblocked
    // season/resolve, so if it were serial-after, season/resolve would already have had
    // to complete first and this call would never happen (the promise above would hang
    // and the test would time out instead of resolving `status`).
    expect(familyIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
  });
});
