// Regression coverage for the Career hub's peer-tab back navigation bug (13.07.2026):
// Stats/Titles/Achievements are peer tabs of one "Career" group (LOBBY_IA_REDESIGN §3),
// not a navigation stack. Switching tabs (e.g. Stats -> Titles) used to rebind Titles'
// back button to `goStats()` unconditionally, so pressing back from Titles landed back
// on the Stats tab instead of returning to wherever Career was entered from (the lobby)
// -- a user had to press back twice. Fixed in src/app/nav/game.ts by threading the same
// `back` closure through goStats/goAchievements/goTitles instead of each hardcoding a
// hop to goStats().
//
// These tests drive the *actual* onOpenTitles/onOpenAchievements callbacks the scenes
// invoke on tab click (not goTitles/goAchievements directly), so they pin the wiring,
// not just the function signatures.
//
// Hand-built AppCtx style, same as test/game-nav-fight-again.test.ts.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { StatsCallbacks } from '../src/scenes/StatsScene';
import type { TitlesSceneCallbacks } from '../src/scenes/TitlesScene';
import type { AchievementCallbacks } from '../src/scenes/AchievementScene';
import { TOKEN_KEY } from '../src/app/appConstants';

function buildCtx(): {
  ctx: AppCtx;
  getStats: () => StatsCallbacks | null;
  getTitles: () => TitlesSceneCallbacks | null;
  getAchievements: () => AchievementCallbacks | null;
  goLobbyCalls: () => number;
} {
  let lastStats: StatsCallbacks | null = null;
  let lastTitles: TitlesSceneCallbacks | null = null;
  let lastAchievements: AchievementCallbacks | null = null;
  let goLobbyCalls = 0;

  const views = {
    showStats: (cb: StatsCallbacks) => { lastStats = cb; },
    showTitles: (cb: TitlesSceneCallbacks) => { lastTitles = cb; },
    showAchievements: (cb: AchievementCallbacks) => { lastAchievements = cb; },
  } as unknown as AppViews;

  const nav: Partial<Nav> = {
    goLobby: () => { goLobbyCalls++; },
  };

  const ctx: AppCtx = {
    platform: { storage: { getItem: (k: string) => (k === TOKEN_KEY ? 'test-token' : null) } } as unknown as AppCtx['platform'],
    views,
    api: {} as ApiClient, // truthy so the logged-in onOpenTitles/onOpenAchievements branches are wired (matches shopNav-backNavigation.test.ts's api stub)
    baseUrl: null,
    saveManager: {
      get: () => ({
        pvp: { rank: 0, elo: 1300, wins: 0, losses: 0, streak: 0 },
        progress: { stars: {}, cleared: [] },
        inventory: { skins: [] },
        materials: {},
        titles: [],
        equipped: {},
      }),
      update: () => {},
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true, offlineMode: false, achievementClaimable: false } as unknown as AppState,
    nav: nav as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return {
    ctx,
    getStats: () => lastStats,
    getTitles: () => lastTitles,
    getAchievements: () => lastAchievements,
    goLobbyCalls: () => goLobbyCalls,
  };
}

describe('createGameNav — Career hub (Stats/Titles/Achievements) peer-tab back navigation', () => {
  it('Stats -> Titles tab -> back returns straight to the lobby, not the Stats tab', () => {
    const { ctx, getStats, getTitles, goLobbyCalls } = buildCtx();
    const { goStats } = createGameNav(ctx);

    // Lobby -> Career (Stats tab), matching lobby.ts's `nav.goStats()` (no back arg -> defaults to goLobby).
    goStats();
    const stats = getStats();
    if (!stats?.onOpenTitles) throw new Error('StatsScene was not wired with onOpenTitles');

    // Simulate the user clicking the Titles tab.
    stats.onOpenTitles();
    const titles = getTitles();
    if (!titles) throw new Error('views.showTitles was not called by onOpenTitles()');

    titles.onBack();
    expect(goLobbyCalls()).toBe(1); // must go straight to the lobby, not back through Stats
  });

  it('Stats -> Achievements tab -> back returns straight to the lobby, not the Stats tab', () => {
    const { ctx, getStats, getAchievements, goLobbyCalls } = buildCtx();
    const { goStats } = createGameNav(ctx);

    goStats();
    const stats = getStats();
    if (!stats?.onOpenAchievements) throw new Error('StatsScene was not wired with onOpenAchievements');

    stats.onOpenAchievements();
    const achievements = getAchievements();
    if (!achievements) throw new Error('views.showAchievements was not called by onOpenAchievements()');

    achievements.onBack();
    expect(goLobbyCalls()).toBe(1);
  });

  it('Achievements -> Titles tab -> back threads the same origin through both hops', () => {
    const { ctx, getAchievements, getTitles, goLobbyCalls } = buildCtx();
    const { goAchievements } = createGameNav(ctx);

    // Direct lobby -> Achievements entry (lobby.ts's `nav.goAchievements(goLobby)`).
    goAchievements(() => ctx.nav.goLobby());
    const achievements = getAchievements();
    if (!achievements) throw new Error('views.showAchievements was not called by goAchievements()');

    if (!achievements.onOpenTitles) throw new Error('AchievementsScene was not wired with onOpenTitles');
    achievements.onOpenTitles();
    const titles = getTitles();
    if (!titles) throw new Error('views.showTitles was not called by onOpenTitles()');

    titles.onBack();
    expect(goLobbyCalls()).toBe(1); // origin threaded through Achievements -> Titles, not dropped
  });

  it('Titles opened standalone (no back passed): defaults to the Stats/Career root, not the lobby', () => {
    const { ctx, getStats, getTitles, goLobbyCalls } = buildCtx();
    const { goTitles } = createGameNav(ctx);

    goTitles();
    const titles = getTitles();
    if (!titles) throw new Error('views.showTitles was not called by goTitles()');

    titles.onBack();
    // Falls back to goStats() (re-renders Stats), not the lobby directly -- this is the
    // documented default for a standalone Titles entry, distinct from the tab-switch case above.
    expect(getStats()).not.toBeNull();
    expect(goLobbyCalls()).toBe(0);
  });
});
