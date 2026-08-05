// Lobby feedback strip entry wiring (UI_DESIGN.md §4.1.1, 2026-08-04): the right-side strip's
// feedback item replaced the low-usage achievement shortcut there (achievements are still reachable
// via the Career hub tabs / unlock toast). createLobbyNav's goLobby() wires callbacks.onOpenFeedback
// only when `online` (same gating as onOpenAchievements/onOpenAuction above it in lobby.ts) to
// `analytics.click('lobby.feedback')` + `requestFeedbackDialog()` — a direct player tap, not a
// network-error prompt (contrast with net/log's appeal sink), which is why the wiring itself (not
// just the sink, covered by feedback-prompt.test.ts) needs its own regression coverage.
//
// Drives the real createLobbyNav()/goLobby() — no PIXI: LobbySceneCallbacks is a plain interface and
// HeadlessAppViews.showLobby just records it. Hand-built AppCtx style, same as
// shopNav-peerBadges.test.ts / careerNav-backNavigation.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLobbyNav } from '../src/app/nav/lobby';
import * as analytics from '../src/analytics';
import { setFeedbackSink } from '../src/net/log';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

/** Same construction style as shopNav-peerBadges.test.ts — a real createLobbyNav() with just enough
 *  of AppCtx stubbed to exercise the goLobby() callback wiring (no PIXI, no network). */
function buildLobbyNav(opts: { online: boolean }): { views: HeadlessAppViews; goLobby: Nav['goLobby'] } {
  const storage = new MemStorage();
  if (opts.online) storage.setItem(TOKEN_KEY, 'test-token');
  const platform = {
    storage,
    iapKind: () => null,
    onGameplayStop: () => {},
  } as unknown as IPlatform;
  const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });

  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: false, offlineMode: !opts.online, gatewayUrl: opts.online ? 'wss://x/gw' : null,
    netSession: null,
    // Bypass the one-shot "first lobby entry -> FTUE tutorial redirect" branch (ONBOARDING_DESIGN §2
    // step ⑤) — irrelevant to the feedback-entry wiring under test, matching a returning player.
    firstLobbyHandled: true,
    socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };

  const nav = {} as Nav;
  nav.goLobby = () => {};

  const ctx: AppCtx = {
    platform,
    views,
    api: {} as ApiClient, // truthy — online-gating only checks !!api, never calls a method on it here
    baseUrl: null,
    saveManager,
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: null,
    state,
    nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  Object.assign(nav, createLobbyNav(ctx));
  return { views, goLobby: nav.goLobby };
}

describe('lobby.ts — feedback strip entry (onOpenFeedback)', () => {
  afterEach(() => {
    setFeedbackSink(() => {}); // reset, same reasoning as appeal-prompt.test.ts's afterEach
    vi.restoreAllMocks();
  });

  it('wires onOpenFeedback when online: tapping it tracks analytics and opens the dialog via the sink', () => {
    const { views, goLobby } = buildLobbyNav({ online: true });
    const clickSpy = vi.spyOn(analytics, 'click').mockImplementation(() => {});
    const sink = vi.fn();
    setFeedbackSink(sink);

    goLobby();
    if (!views.lobby?.onOpenFeedback) throw new Error('lobby.ts did not wire onOpenFeedback while online');

    views.lobby.onOpenFeedback();

    expect(clickSpy).toHaveBeenCalledWith('lobby.feedback');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('does not wire onOpenFeedback when offline (no api/gateway/login) — same gating as onOpenAchievements/onOpenAuction', () => {
    const { views, goLobby } = buildLobbyNav({ online: false });

    goLobby();

    expect(views.lobby?.onOpenFeedback).toBeUndefined();
  });
});
