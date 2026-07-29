// Regression test for "配置了队伍，攻占土地却提示没有队伍" (account tao, 2026-07-29): closing the City
// overlay (e.g. after filling a team's troops in the formation editor) returned to the still-alive
// WorldMapScene (ADR-044 — the map never tears down/rebuilds for an overlay) without ever re-fetching
// `me`. showTeamPicker's occupy/attack usable-team filter reads cardState.currentTroops off that stale
// cached `me`, so a team just given troops kept reading 0 and dropped out of the picker, surfacing
// "No teams yet — go edit a formation" even though the team was fully configured. Fixed by having
// WorldMapView.refreshMe() get called whenever an overlay (City/defense editor/auction/chat) pops back
// to the map — see app/nav/world.ts's returnToMap.
import { describe, it, expect, vi } from 'vitest';
import { createWorldNav } from '../src/app/nav/world';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { CitySceneCallbacks } from '../src/scenes/CityScene';
import type { WorldMapCallbacks, WorldMapView } from '../src/scenes/worldmap/WorldMapContext';
import { WorldApiClient } from '../src/net/WorldApiClient';

function buildCtx(): {
  ctx: AppCtx;
  getMapCb: () => WorldMapCallbacks;
  getCityCb: () => CitySceneCallbacks;
  refreshMe: ReturnType<typeof vi.fn>;
  hideOverlay: ReturnType<typeof vi.fn>;
} {
  let mapCb: WorldMapCallbacks | null = null;
  let cityCb: CitySceneCallbacks | null = null;
  const refreshMe = vi.fn();
  const hideOverlay = vi.fn();

  const views = {
    showWorldMap: (cb: WorldMapCallbacks): WorldMapView => {
      mapCb = cb;
      return {
        applyMarchUpdate() {}, applyTileUpdate() {}, applyUnderAttack() {},
        applySiegeResult() {}, applyNationMsg() {}, refreshMe,
      };
    },
    showCity: (cb: CitySceneCallbacks) => { cityCb = cb; },
    hideOverlay,
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: { storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as AppCtx['api'],
    baseUrl: null,
    saveManager: { get: () => ({ accountId: 'acct_1', wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: {} as unknown as AppState,
    nav: { goLobby: () => {} } as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'Tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return {
    ctx,
    getMapCb: () => { if (!mapCb) throw new Error('views.showWorldMap was not called'); return mapCb; },
    getCityCb: () => { if (!cityCb) throw new Error('views.showCity was not called'); return cityCb; },
    refreshMe,
    hideOverlay,
  };
}

const worldApi = {} as unknown as WorldApiClient;

describe('closing an SLG overlay refreshes the still-alive WorldMapScene\'s `me`', () => {
  it('City onBack (returnToMap) calls WorldMapView.refreshMe()', () => {
    const { ctx, getMapCb, getCityCb, refreshMe, hideOverlay } = buildCtx();
    createWorldNav(ctx).goWorldMap(worldApi, 'world:1:0');

    getMapCb().onOpenCity();
    expect(refreshMe).not.toHaveBeenCalled(); // opening City must not itself trigger a refresh

    getCityCb().onBack();
    expect(hideOverlay).toHaveBeenCalledTimes(1);
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });
});
