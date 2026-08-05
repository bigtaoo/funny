/**
 * lobbyNavBadgesGuideRanked.test.ts — direct coverage of `app/nav/lobby.ts`'s `refreshLobbyBadges`,
 * `withGuide`, `onStartRanked`, and the season-settlement popup — the 2026-08-05 client-test-audit
 * flagged this nav hub as "nearly zero-coverage": the only existing test touching this file
 * (`lobby-feedback-nav.test.ts`) covers just the `onOpenFeedback` wiring; `lobbyFormat.test.ts`/
 * `lobbyHeader.test.ts` only test pure geometry/format helpers with no nav logic at all.
 *
 * Drives the real `createLobbyNav()`/`goLobby()` — no PIXI. `LobbySceneCallbacks`/`LobbyView` are
 * plain interfaces, so `views.showLobby` is hand-rolled here (rather than reusing
 * `HeadlessAppViews`) specifically so `showFeatureGuide`/`showSeasonSettlement` calls can be
 * captured WITHOUT auto-firing `onDismiss` — `HeadlessAppViews.showLobby` immediately calls
 * `onDismiss()`, which would make it impossible to tell apart "guide shown, dismissal pending" from
 * "already seen, guide never shown". Same hand-built-AppCtx style as
 * `lobby-feedback-nav.test.ts`/`shopNav-peerBadges.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as analytics from '../src/analytics';
import { createLobbyNav } from '../src/app/nav/lobby';
import { getPvpUnlockedCards, PVP_DECK_SIZE } from '../src/game/meta/pvpLoadout';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews, LobbyView } from '../src/app/AppViews';
import type { LobbySceneCallbacks } from '../src/scenes/LobbyScene';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { TOKEN_KEY, LAST_SEEN_SEASON_KEY } from '../src/app/appConstants';
import type { ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';
import type { LobbyBadgesView } from '../src/net/ApiClient/types';
import type { Achievement } from '../src/net/ApiClient';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function makeAchievementDef(id: string, threshold: number): Achievement {
  return { id, statKey: id, tiers: [{ threshold, reward: { kind: 'coins', count: 10 } }] } as unknown as Achievement;
}

function makeLobbyBadges(overrides: Partial<LobbyBadgesView> = {}): LobbyBadgesView {
  return {
    social: { friendRequests: 0, chat: 0, mail: 0, total: 0 },
    achievements: { defs: [], stats: {}, achievements: {} },
    retentionClaimable: { checkin: false, daily: false, weekly: false },
    eventsAvailable: false,
    ...overrides,
  } as unknown as LobbyBadgesView;
}

interface Captured {
  cb?: LobbySceneCallbacks;
  socialBadge?: [number, number];
  achievementBadge?: boolean;
  shopBadge?: boolean;
  retentionBadge?: boolean;
  eventsAvailable?: boolean;
  worldAvailable?: boolean;
  achievementToasts: string[];
  featureGuideCalls: { titleKey: string; bodyKey: string; onDismiss: () => void }[];
  seasonSettlementCalls: [number, string, number][];
}

function buildLobbyNav(opts: {
  online: boolean;
  api?: Partial<ApiClient>;
  seasonNo?: number;
  seasonPeakRank?: string;
  rank?: string;
  elo?: number;
  pvpDeck?: string[];
  lastSeenSeason?: number;
  featSeen?: string[];
} = { online: true }): { ctx: AppCtx; captured: Captured; goLobby: Nav['goLobby']; nav: Nav; storage: MemStorage } {
  const storage = new MemStorage();
  if (opts.online) storage.setItem(TOKEN_KEY, 'test-token');
  if (opts.lastSeenSeason !== undefined) storage.setItem(LAST_SEEN_SEASON_KEY, String(opts.lastSeenSeason));

  const platform = {
    storage,
    iapKind: () => null,
    onGameplayStop: () => {},
  } as unknown as AppCtx['platform'];

  const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });
  Object.assign(saveManager.get().pvp, {
    elo: opts.elo ?? 1000,
    rank: opts.rank ?? 'unranked',
    ...(opts.seasonNo !== undefined ? { seasonNo: opts.seasonNo } : {}),
    ...(opts.seasonPeakRank !== undefined ? { seasonPeakRank: opts.seasonPeakRank } : {}),
  });
  if (opts.pvpDeck) saveManager.get().pvpDeck = opts.pvpDeck;
  for (const f of opts.featSeen ?? []) saveManager.markFeatSeen(f);

  const captured: Captured = { achievementToasts: [], featureGuideCalls: [], seasonSettlementCalls: [] };
  const views = {
    showLobby(cb: LobbySceneCallbacks): LobbyView {
      captured.cb = cb;
      return {
        applySocialBadge: (n, mail) => { captured.socialBadge = [n, mail]; },
        applyAchievementBadge: (c) => { captured.achievementBadge = c; },
        applyShopBadge: (c) => { captured.shopBadge = c; },
        applyRetentionBadge: (c) => { captured.retentionBadge = c; },
        applyEventsAvailable: (a) => { captured.eventsAvailable = a; },
        applyWorldAvailable: (ok) => { captured.worldAvailable = ok; },
        showAchievementToast: (msg) => { captured.achievementToasts.push(msg); },
        showSeasonSettlement: (oldNo, peakRank, newNo) => { captured.seasonSettlementCalls.push([oldNo, peakRank, newNo]); },
        showFeatureGuide: (titleKey, bodyKey, onDismiss) => {
          captured.featureGuideCalls.push({ titleKey, bodyKey, onDismiss });
        },
      };
    },
  } as unknown as AppViews;

  const state: AppState = {
    inLobby: false, offlineMode: !opts.online, gatewayUrl: opts.online ? 'wss://x/gw' : null,
    netSession: null,
    firstLobbyHandled: true, // bypass the FTUE tutorial redirect — irrelevant to badges/guide/ranked
    socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };

  const nav = {} as Nav;
  nav.goLobby = () => {};
  nav.goFriends = vi.fn();
  nav.goRoom = vi.fn();
  nav.goDeckBuilder = vi.fn();

  const defaultApi = {
    getLobbyBadges: vi.fn(async () => makeLobbyBadges()),
    getSocialBadges: vi.fn(async () => ({ friendRequests: 0, chat: 0, mail: 0, total: 0 })),
    checkHealth: vi.fn(async () => true),
  };

  const ctx: AppCtx = {
    platform,
    views,
    api: { ...defaultApi, ...opts.api } as unknown as ApiClient,
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
  return { ctx, captured, goLobby: nav.goLobby, nav, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── refreshLobbyBadges ────────────────────────────────────────────────────────

describe('lobby.ts — refreshLobbyBadges()', () => {
  it('online entry: fetches once and applies social/achievement/retention/events badges', async () => {
    const { ctx, captured } = buildLobbyNav({ online: true });
    (ctx.api!.getLobbyBadges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeLobbyBadges({
      social: { friendRequests: 1, chat: 0, mail: 2, total: 3 },
      achievements: { defs: [makeAchievementDef('a1', 5)], stats: { a1: 5 }, achievements: {} },
      retentionClaimable: { checkin: true, daily: false, weekly: false },
      eventsAvailable: true,
    }));
    ctx.nav.goLobby();
    await Promise.resolve(); await Promise.resolve(); // let the fire-and-forget refreshLobbyBadges settle

    expect(ctx.api!.getLobbyBadges).toHaveBeenCalledTimes(1);
    expect(captured.socialBadge).toEqual([3, 2]);
    expect(captured.achievementBadge).toBe(true); // a1's tier-1 threshold (5) is reached
    expect(captured.retentionBadge).toBe(true);
    expect(captured.eventsAvailable).toBe(true);
  });

  it('2026-08-05 fix: a weekly-only claimable chest still lights the retention red dot', async () => {
    const { ctx, captured } = buildLobbyNav({ online: true });
    (ctx.api!.getLobbyBadges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeLobbyBadges({
      retentionClaimable: { checkin: false, daily: false, weekly: true },
    }));
    ctx.nav.goLobby();
    await Promise.resolve(); await Promise.resolve();

    expect(captured.retentionBadge).toBe(true);
  });

  it('first refresh seeds the achievement-reached baseline WITHOUT a toast (nothing to diff against yet)', async () => {
    const { ctx, captured } = buildLobbyNav({ online: true });
    (ctx.api!.getLobbyBadges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeLobbyBadges({
      achievements: { defs: [makeAchievementDef('a1', 5)], stats: { a1: 5 }, achievements: {} },
    }));
    ctx.nav.goLobby();
    await Promise.resolve(); await Promise.resolve();

    expect(captured.achievementToasts).toEqual([]);
  });

  it('a newly-reached tier since the last refresh triggers a single toast + analytics event', async () => {
    const { ctx, captured } = buildLobbyNav({ online: true });
    const trackSpy = vi.spyOn(analytics, 'track');
    (ctx.api!.getLobbyBadges as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeLobbyBadges({ achievements: { defs: [makeAchievementDef('a1', 5)], stats: { a1: 0 }, achievements: {} } }))
      .mockResolvedValueOnce(makeLobbyBadges({ achievements: { defs: [makeAchievementDef('a1', 5)], stats: { a1: 5 }, achievements: {} } }));

    ctx.nav.goLobby(); // seeds the baseline (a1 not yet reached)
    await Promise.resolve(); await Promise.resolve();
    ctx.nav.goLobby(); // a1 now reached
    await Promise.resolve(); await Promise.resolve();

    expect(captured.achievementToasts).toHaveLength(1);
    expect(trackSpy).toHaveBeenCalledWith('achievement_unlock_toast', { count: 1 });
  });

  it('is a no-op (best-effort, no throw) when the fetch rejects — badges stay at cached defaults', async () => {
    const { ctx, captured } = buildLobbyNav({ online: true });
    (ctx.api!.getLobbyBadges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    expect(() => ctx.nav.goLobby()).not.toThrow();
    await Promise.resolve(); await Promise.resolve();

    // goLobby() always paints the CACHED social total synchronously on entry, independent of this
    // fetch — so applySocialBadge itself still fires with the (0,0) cached default. retentionBadge
    // has no such synchronous painter, so its being unset is the real proof the fetch's success
    // path never ran.
    expect(captured.socialBadge).toEqual([0, 0]);
    expect(captured.retentionBadge).toBeUndefined();
  });

  it('does not fetch at all when offline', async () => {
    const { ctx } = buildLobbyNav({ online: false });
    ctx.nav.goLobby();
    await Promise.resolve(); await Promise.resolve();
    expect((ctx.api as unknown as { getLobbyBadges: ReturnType<typeof vi.fn> })?.getLobbyBadges).not.toHaveBeenCalled();
  });

  it('does not re-fetch on a resize-triggered re-show', async () => {
    const { ctx } = buildLobbyNav({ online: true });
    ctx.nav.goLobby({ fromResize: true });
    await Promise.resolve(); await Promise.resolve();
    expect(ctx.api!.getLobbyBadges).not.toHaveBeenCalled();
  });
});

// ── withGuide (tested via onOpenSocial, representative of every withGuide-wrapped entry) ────────

describe('lobby.ts — withGuide() first-time feature-guide gate', () => {
  it('not yet seen: shows the guide card, marks it seen immediately, and only navigates after dismiss', () => {
    const { ctx, captured, nav } = buildLobbyNav({ online: true });
    const trackSpy = vi.spyOn(analytics, 'track');
    ctx.nav.goLobby();

    captured.cb!.onOpenSocial!();

    expect(captured.featureGuideCalls).toHaveLength(1);
    expect(captured.featureGuideCalls[0]!.titleKey).toBe('guide.social.title');
    expect(trackSpy).toHaveBeenCalledWith('feature_guide_shown', { feature: 'social' });
    expect(ctx.saveManager.featSeen('social')).toBe(true); // marked BEFORE dismissal, not after
    expect(nav.goFriends).not.toHaveBeenCalled(); // navigation deferred until the card is dismissed

    captured.featureGuideCalls[0]!.onDismiss();

    expect(trackSpy).toHaveBeenCalledWith('feature_guide_closed', { feature: 'social' });
    expect(nav.goFriends).toHaveBeenCalledTimes(1);
  });

  it('already seen: navigates directly, the guide card never shows, and no guide analytics fire', () => {
    const { ctx, captured, nav } = buildLobbyNav({ online: true, featSeen: ['social'] });
    const trackSpy = vi.spyOn(analytics, 'track');
    ctx.nav.goLobby();

    captured.cb!.onOpenSocial!();

    expect(captured.featureGuideCalls).toHaveLength(0);
    expect(nav.goFriends).toHaveBeenCalledTimes(1);
    expect(trackSpy).not.toHaveBeenCalledWith('feature_guide_shown', expect.anything());
  });
});

// ── onStartRanked ─────────────────────────────────────────────────────────────

describe('lobby.ts — onStartRanked()', () => {
  it('below the first unlock tier (unlocked pool == PVP_DECK_SIZE): skips the deck builder and queues directly', () => {
    const { ctx, captured: cap, nav } = buildLobbyNav({ online: true, elo: 1000 }); // below the 1500 unlock tier
    ctx.nav.goLobby();

    cap.cb!.onStartRanked!();

    expect(nav.goDeckBuilder).not.toHaveBeenCalled();
    expect(nav.goRoom).toHaveBeenCalledWith({ autoRanked: true });
    expect(ctx.saveManager.get().pvpDeck).toEqual(getPvpUnlockedCards(1000));
  });

  it('does not overwrite an already-valid pvpDeck (avoids an unnecessary write)', () => {
    const validDeck = getPvpUnlockedCards(1000);
    const { ctx, captured: cap, nav } = buildLobbyNav({ online: true, elo: 1000, pvpDeck: validDeck });
    const before = ctx.saveManager.get().pvpDeck;
    ctx.nav.goLobby();

    cap.cb!.onStartRanked!();

    expect(ctx.saveManager.get().pvpDeck).toBe(before); // same reference — patchLocal never ran
    expect(nav.goRoom).toHaveBeenCalledWith({ autoRanked: true });
  });

  it('overwrites an invalid existing pvpDeck (wrong size) before queuing', () => {
    const { ctx, captured: cap, nav } = buildLobbyNav({ online: true, elo: 1000, pvpDeck: ['only_one_card'] });
    ctx.nav.goLobby();

    cap.cb!.onStartRanked!();

    expect(ctx.saveManager.get().pvpDeck).toEqual(getPvpUnlockedCards(1000));
    expect(nav.goRoom).toHaveBeenCalledWith({ autoRanked: true });
  });

  it('above the first unlock tier (unlocked pool > PVP_DECK_SIZE): opens the deck builder instead', () => {
    const { ctx, captured: cap, nav } = buildLobbyNav({ online: true, elo: 1500 }); // unlocks 'runner'/'ironclad' → 12 cards
    expect(getPvpUnlockedCards(1500).length).toBeGreaterThan(PVP_DECK_SIZE);
    ctx.nav.goLobby();

    cap.cb!.onStartRanked!();

    expect(nav.goRoom).not.toHaveBeenCalled();
    expect(nav.goDeckBuilder).toHaveBeenCalledTimes(1);

    // Confirming the deck builder (its onSave callback) is what actually queues ranked.
    const onSave = (nav.goDeckBuilder as ReturnType<typeof vi.fn>).mock.calls[0]![0] as () => void;
    onSave();
    expect(nav.goRoom).toHaveBeenCalledWith({ autoRanked: true });
  });
});

// ── Season settlement ─────────────────────────────────────────────────────────

describe('lobby.ts — season-settlement popup', () => {
  it('the very first entry (no stored last-seen season) never shows the popup but records the current season', () => {
    const { ctx, captured: cap, storage } = buildLobbyNav({ online: true, seasonNo: 3 });
    ctx.nav.goLobby();

    expect(cap.seasonSettlementCalls).toEqual([]);
    expect(storage.getItem(LAST_SEEN_SEASON_KEY)).toBe('3');
  });

  it('re-entering on the same season shows nothing (idempotent)', () => {
    const { ctx, captured: cap } = buildLobbyNav({ online: true, seasonNo: 3, lastSeenSeason: 3 });
    ctx.nav.goLobby();
    expect(cap.seasonSettlementCalls).toEqual([]);
  });

  it('a season bump since the last-seen value shows the settlement with the peak rank and updates storage', () => {
    const { ctx, captured: cap, storage } = buildLobbyNav({
      online: true, seasonNo: 4, lastSeenSeason: 3, seasonPeakRank: 'gold', rank: 'silver',
    });
    ctx.nav.goLobby();

    expect(cap.seasonSettlementCalls).toEqual([[3, 'gold', 4]]);
    expect(storage.getItem(LAST_SEEN_SEASON_KEY)).toBe('4');
  });

  it('falls back to the CURRENT rank when seasonPeakRank was never recorded', () => {
    const { ctx, captured: cap } = buildLobbyNav({ online: true, seasonNo: 4, lastSeenSeason: 3, rank: 'bronze' });
    ctx.nav.goLobby();
    expect(cap.seasonSettlementCalls).toEqual([[3, 'bronze', 4]]);
  });

  it('a resize re-show never touches the season-settlement check at all (no storage write)', () => {
    const { ctx, captured: cap, storage } = buildLobbyNav({ online: true, seasonNo: 3 });
    ctx.nav.goLobby({ fromResize: true });

    expect(cap.seasonSettlementCalls).toEqual([]);
    expect(storage.getItem(LAST_SEEN_SEASON_KEY)).toBeNull();
  });
});
