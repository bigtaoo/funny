// Regression test for "family/sect hub always returns to the SLG world map" (09.07.2026).
//
// Root cause: FriendsScene's family/sect tabs delegate to `cb.openFamilyHub?.()` /
// `cb.openSectHub?.()` once the player already belongs to one, which called
// `nav.goFamilyHub(worldApi, slgWorldId)` / `nav.goSectHub(worldApi, slgWorldId)` with no
// third argument — so those hubs' `onBack` (world.ts) always defaulted to `goWorldMap`,
// regardless of whether the social hub was originally opened from the lobby, the world map,
// or (in the future) anywhere else. Fixed by capturing `goFriends`'s own `onBack` resolution
// (`backTo`, which also restores the gateway push handlers) and threading it through as the
// third argument to `nav.goFamilyHub`/`nav.goSectHub`.
//
// This test pins the contract at the `createSocialNav` boundary: whatever `onBack` was passed
// to `goFriends(...)` must be the function `nav.goFamilyHub`/`nav.goSectHub` receive as onExit.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSocialNav } from '../src/app/nav/social';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FriendsSceneCallbacks } from '../src/scenes/FriendsScene';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Stubs just enough of worldsvc/socialsvc so `ensureWorldId()` (inside loadSLGStatus)
 *  resolves a worldId without throwing. Family lookup is allowed to fail — loadSLGStatus
 *  already tolerates that via `.catch(() => null)`. */
function stubWorldFetch(): void {
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (url.includes('/world/active-season')) return jsonResponse({ ok: true, data: { season: 1 } });
    if (url.includes('/world/season/resolve')) return jsonResponse({ ok: true, data: { worldId: 'world:1:0' } });
    if (url.includes('/social/family/mine')) return jsonResponse({ ok: true, data: null });
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

function buildCtx(nav: Partial<Nav>): { ctx: AppCtx; getCb: () => FriendsSceneCallbacks } {
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
    nav: nav as Nav,
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

describe('regression: family/sect hub must return to wherever social was opened from', () => {
  it('openFamilyHub forwards a custom onBack (e.g. the world map) as goFamilyHub\'s onExit', async () => {
    stubWorldFetch();
    const goFamilyHub = vi.fn();
    const customOnBack = vi.fn();
    const { ctx, getCb } = buildCtx({ goFamilyHub, goLobby: vi.fn() });
    const { goFriends } = createSocialNav(ctx);

    goFriends({ onBack: customOnBack });
    const cb = getCb();
    // slgWorldId is only populated once loadSLGStatus has resolved.
    await cb.loadSLGStatus?.();
    cb.openFamilyHub?.();

    expect(goFamilyHub).toHaveBeenCalledTimes(1);
    const [, worldId, onExit] = goFamilyHub.mock.calls[0]!;
    expect(worldId).toBe('world:1:0');
    expect(onExit).toBeInstanceOf(Function);

    onExit();
    expect(customOnBack).toHaveBeenCalledTimes(1);
  });

  it('openSectHub forwards the same onBack as goSectHub\'s onExit', async () => {
    stubWorldFetch();
    const goSectHub = vi.fn();
    const customOnBack = vi.fn();
    const { ctx, getCb } = buildCtx({ goSectHub, goLobby: vi.fn() });
    const { goFriends } = createSocialNav(ctx);

    goFriends({ onBack: customOnBack });
    const cb = getCb();
    await cb.loadSLGStatus?.();
    cb.openSectHub?.();

    expect(goSectHub).toHaveBeenCalledTimes(1);
    const [, worldId, onExit] = goSectHub.mock.calls[0]!;
    expect(worldId).toBe('world:1:0');

    onExit();
    expect(customOnBack).toHaveBeenCalledTimes(1);
  });

  it('with no onBack passed (e.g. opened from the lobby), the hub falls back to goLobby — not a hardcoded world map', async () => {
    stubWorldFetch();
    const goFamilyHub = vi.fn();
    const goLobby = vi.fn();
    const { ctx, getCb } = buildCtx({ goFamilyHub, goLobby });
    const { goFriends } = createSocialNav(ctx);

    goFriends(); // no opts at all — this is the lobby entry point's call shape
    const cb = getCb();
    await cb.loadSLGStatus?.();
    cb.openFamilyHub?.();

    const [, , onExit] = goFamilyHub.mock.calls[0]!;
    onExit();
    expect(goLobby).toHaveBeenCalledTimes(1);
  });
});
