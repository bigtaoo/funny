// Regression test for the "scene cross-fade scope" fix (2026-07-12, ADR-036,
// design/DECISIONS.md): SceneManager.goto() used to fade on EVERY scene switch;
// it now defaults to instant and only the handful of nav call sites that enter/exit
// a match or the SLG world map pass `{ fade: true }` through to `views.showLobby`/
// `views.showGame`/`views.showWorldMap`. See client/test/ui/sceneManager.ui.ts for
// the generic instant-vs-fade mechanics; this file pins WHICH call sites opt in,
// using the same hand-built-AppCtx unit-test style as
// test/game-nav-fight-again.test.ts and test/result-nav-onback.test.ts.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import { createWorldNav } from '../src/app/nav/world';
import { createResultNav } from '../src/app/nav/result';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { GameSceneCallbacks, GameSceneOptions } from '../src/scenes/GameScene';
import type { WorldMapCallbacks } from '../src/scenes/WorldMapScene';
import type { WorldApiClient } from '../src/net/WorldApiClient';
import type { PlayerStats } from '../src/game/types';
import { CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';

const zeroStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

/** Records every `nav.goLobby(opts)` call so a test can assert both count and the `fade` flag. */
function recordingGoLobby(): { goLobby: Nav['goLobby']; calls: Array<{ fade?: boolean }> } {
  const calls: Array<{ fade?: boolean }> = [];
  return { goLobby: (opts) => { calls.push({ fade: opts?.fade }); }, calls };
}

function buildGameCtx(nav: Partial<Nav>): {
  ctx: AppCtx;
  getGameCall: () => { cb: GameSceneCallbacks; opts: GameSceneOptions } | null;
} {
  let lastGame: { cb: GameSceneCallbacks; opts: GameSceneOptions } | null = null;
  const views = {
    showGame: (cb: GameSceneCallbacks, opts: GameSceneOptions) => { lastGame = { cb, opts }; },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: { onGameplayStart: () => {}, onGameplayStop: () => {} } as unknown as AppCtx['platform'],
    views,
    api: undefined,
    baseUrl: null,
    saveManager: {
      get: () => ({ equipped: {}, pvp: { elo: 1300 } }),
      update: () => {},
      getFlag: () => true,
      setFlag: () => {},
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
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

  return { ctx, getGameCall: () => lastGame };
}

describe('nav/game — exiting a match always fades back to the lobby', () => {
  it('practice/ranked local match: onExitToLobby (abandon) passes { fade: true }', () => {
    const { goLobby, calls } = recordingGoLobby();
    const { ctx, getGameCall } = buildGameCtx({ goLobby });
    const { goGame } = createGameNav(ctx);

    goGame();
    const call = getGameCall();
    if (!call) throw new Error('views.showGame was not called by goGame()');

    call.cb.onExitToLobby();
    expect(calls).toEqual([{ fade: true }]);
  });

  it('campaign match: onExitToLobby (level abandon) passes { fade: true }', () => {
    const { goLobby, calls } = recordingGoLobby();
    const { ctx, getGameCall } = buildGameCtx({ goLobby, goCampaignMap: () => {} });
    const { goCampaign } = createGameNav(ctx);

    goCampaign(CAMPAIGN_LEVEL_ORDER[0]);
    const call = getGameCall();
    if (!call) throw new Error('views.showGame was not called by goCampaign()');

    call.cb.onExitToLobby();
    expect(calls).toEqual([{ fade: true }]);
  });

  it('tutorial: both onGameEnd (complete) and onExitToLobby (skip) pass { fade: true }', () => {
    const { goLobby, calls } = recordingGoLobby();
    const { ctx, getGameCall } = buildGameCtx({ goLobby });
    const { goTutorial } = createGameNav(ctx);

    goTutorial();
    const call = getGameCall();
    if (!call) throw new Error('views.showGame was not called by goTutorial()');
    call.cb.onGameEnd(0, [zeroStats(0), zeroStats(1)], undefined);
    expect(calls).toEqual([{ fade: true }]);

    // Skip path: a fresh tutorial run, then its onExitToLobby.
    goTutorial();
    const second = getGameCall();
    if (!second) throw new Error('views.showGame was not called by the second goTutorial()');
    second.cb.onExitToLobby();
    expect(calls).toEqual([{ fade: true }, { fade: true }]);
  });

  it('control: campaign map "back to lobby" (ordinary nav, not a match exit) does NOT fade', () => {
    const { goLobby, calls } = recordingGoLobby();
    const { ctx } = buildGameCtx({ goLobby });
    const { goCampaignMap } = createGameNav(ctx);

    let campaignMapCb: { onBack: () => void } | null = null;
    (ctx.views as unknown as { showCampaignMap: (cb: { onBack: () => void }) => void }).showCampaignMap =
      (cb) => { campaignMapCb = cb; };

    goCampaignMap();
    if (!campaignMapCb) throw new Error('views.showCampaignMap was not called');
    (campaignMapCb as { onBack: () => void }).onBack();

    expect(calls).toEqual([{ fade: undefined }]); // instant — this is a plain sub-screen back, not a match exit
  });
});

describe('nav/world — exiting the SLG world map always fades back to the lobby', () => {
  it('WorldMapScene onBack passes { fade: true }', () => {
    const { goLobby, calls } = recordingGoLobby();
    let worldMapCb: WorldMapCallbacks | null = null;
    const views = {
      showWorldMap: (cb: WorldMapCallbacks) => {
        worldMapCb = cb;
        return { applyMarchUpdate: () => {}, applyTileUpdate: () => {}, applyUnderAttack: () => {}, applySiegeResult: () => {} };
      },
    } as unknown as AppViews;

    const ctx: AppCtx = {
      platform: { storage: { getItem: () => null } } as unknown as AppCtx['platform'],
      views,
      api: undefined,
      baseUrl: null,
      saveManager: { get: () => ({ wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
      replayStore: {} as unknown as AppCtx['replayStore'],
      featureFlags: null,
      state: { inLobby: true } as unknown as AppState,
      nav: { goLobby } as Nav,
      getNetSession: () => null,
      applyGatewayUrl: () => {},
      playerName: () => 'tester',
      avatarId: () => undefined,
      gateConsent: (next) => next(),
      resolvePvpDeck: () => [],
      keepReplay: (r) => r,
      resolveWorldShard: () => {},
    };

    const { goWorldMap } = createWorldNav(ctx);
    goWorldMap({} as unknown as WorldApiClient, 'world-1');
    if (!worldMapCb) throw new Error('views.showWorldMap was not called by goWorldMap()');

    (worldMapCb as WorldMapCallbacks).onBack();
    expect(calls).toEqual([{ fade: true }]);
  });
});

describe('nav/result — leaving the result screen back to the lobby always fades', () => {
  function buildResultCtx(nav: Partial<Nav>): { ctx: AppCtx; getResult: () => import('../src/app/AppViews').ResultViewProps | null } {
    let captured: import('../src/app/AppViews').ResultViewProps | null = null;
    const views = {
      showResult: (props: import('../src/app/AppViews').ResultViewProps) => { captured = props; },
    } as unknown as AppViews;

    const ctx: AppCtx = {
      platform: { onGameplayStop: () => {}, showMidgameAd: () => Promise.resolve() } as unknown as AppCtx['platform'],
      views,
      api: undefined,
      baseUrl: null,
      saveManager: {} as unknown as AppCtx['saveManager'],
      replayStore: {} as unknown as AppCtx['replayStore'],
      featureFlags: null,
      state: { inLobby: true } as unknown as AppState,
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

    return { ctx, getResult: () => captured };
  }

  it('default onBack / onPlayAgain fallback (no override) passes { fade: true }', async () => {
    const { goLobby, calls } = recordingGoLobby();
    const { ctx, getResult } = buildResultCtx({ goLobby });
    const { goResult } = createResultNav(ctx);

    await goResult(0, [zeroStats(0), zeroStats(1)]);
    const props = getResult();
    if (!props) throw new Error('views.showResult was not called');

    props.cb.onBack();
    props.cb.onPlayAgain();
    expect(calls).toEqual([{ fade: true }, { fade: true }]);
  });
});
