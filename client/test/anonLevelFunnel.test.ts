// The anonymous first-session funnel's level steps (ANALYTICS_DESIGN §3.6d, COMPLIANCE_GLOBAL §3.3b):
// `lvN_start` / `lvN_clear` tick for the first three campaign levels only, and only while the level
// has never been cleared — the row has to mean "a new player got this far", not "someone replayed
// level 1". Same hand-built-AppCtx style as scene-fade-scope.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ticks = vi.hoisted(() => [] as string[]);
vi.mock('../src/analytics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/analytics')>();
  return { ...real, track: () => {}, countAnonymousFunnelStep: (step: string) => { ticks.push(step); } };
});

import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { GameSceneCallbacks } from '../src/scenes/GameScene';
import type { PlayerStats } from '@nw/engine/types';
import { CAMPAIGN_LEVEL_ORDER } from '@nw/engine/campaign/levels';

const stats = (owner: 0 | 1): PlayerStats => ({
  owner, damageDealtToBase: 0, damageTakenByBase: 0, unitsSent: 0, unitsKilled: 5, spellHits: 0,
  killsByType: {}, castsByType: {}, buildingSurvivalTicks: 0, goldSpent: 0,
});

function nav(cleared: string[]): { goCampaign: Nav['goCampaign']; lastGame: () => GameSceneCallbacks } {
  let cb: GameSceneCallbacks | null = null;
  const ctx = {
    platform: { onGameplayStart: () => {}, onGameplayStop: () => {} },
    views: { showGame: (c: GameSceneCallbacks) => { cb = c; } } as unknown as AppViews,
    api: undefined,
    baseUrl: null,
    saveManager: {
      get: () => ({ equipped: {}, pvp: { elo: 1300 }, progress: { cleared, stars: {} } }),
      recordClear: async () => {},
      getFlag: () => true,
      setFlag: () => {},
    },
    replayStore: {},
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
    // Every nav target is a no-op: only the ticks are under test.
    nav: new Proxy({}, { get: () => () => {} }) as unknown as Nav,
    keepReplay: (r: unknown) => r,
    playerName: () => 'tester',
    avatarId: () => undefined,
    getNetSession: () => null,
    resolvePvpDeck: () => [],
  } as unknown as AppCtx;
  const { goCampaign } = createGameNav(ctx);
  return { goCampaign, lastGame: () => { if (!cb) throw new Error('showGame not called'); return cb; } };
}

describe('anonymous funnel: first three campaign levels', () => {
  beforeEach(() => { ticks.length = 0; });

  it('ticks lv1_start on entry and lv1_clear on a starred win while level 1 is uncleared', () => {
    const n = nav([]);
    n.goCampaign(CAMPAIGN_LEVEL_ORDER[0]);
    expect(ticks).toEqual(['lv1_start']);
    n.lastGame().onGameEnd(0, [stats(0), stats(1)], undefined, { elapsedTicks: 300, enemyLeaks: 0, escortMinHpPct: null });
    expect(ticks).toEqual(['lv1_start', 'lv1_clear']);
  });

  it('does not tick a level that was already cleared (a replay is not a new player)', () => {
    const n = nav([CAMPAIGN_LEVEL_ORDER[0]!]);
    n.goCampaign(CAMPAIGN_LEVEL_ORDER[0]);
    n.lastGame().onGameEnd(0, [stats(0), stats(1)], undefined, { elapsedTicks: 300, enemyLeaks: 0, escortMinHpPct: null });
    expect(ticks).toEqual([]);
  });

  it('a loss ticks the start only', () => {
    const n = nav([]);
    n.goCampaign(CAMPAIGN_LEVEL_ORDER[1]);
    n.lastGame().onGameEnd(1, [stats(0), stats(1)], undefined);
    expect(ticks).toEqual(['lv2_start']);
  });

  it('stops after level 3', () => {
    const n = nav([]);
    n.goCampaign(CAMPAIGN_LEVEL_ORDER[3]);
    expect(ticks).toEqual([]);
  });
});
