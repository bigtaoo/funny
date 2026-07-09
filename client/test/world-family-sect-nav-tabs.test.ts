// Regression test for "FamilyScene/SectScene had no way to switch social tabs" (09.07.2026).
//
// Root cause: those two scenes render the shared 5-tab social rail (socialTabRail.ts) but
// need somewhere to send a click on any tab other than their own — that's the new
// FamilySceneCallbacks.onNavTab / SectSceneCallbacks.onNavTab wired up in app/nav/world.ts's
// goFamilyHub/goSectHub. This test pins that wiring directly at the nav-factory boundary
// (no scene construction, no PIXI): clicking 'sect' from the family hub must open the sect
// hub, clicking 'friends'/'world'/'mail' must go through nav.goFriends with the right
// defaultTab, clicking the hub's own tab must be a no-op, and the onExit passed in must
// still be reachable from either hub's onBack (and its default, unset case, must fall back
// to the world map — the previous, only, behavior).
import { describe, it, expect, vi } from 'vitest';
import { createWorldNav } from '../src/app/nav/world';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { FamilySceneCallbacks } from '../src/scenes/FamilyScene';
import type { SectSceneCallbacks } from '../src/scenes/SectScene';
import { WorldApiClient } from '../src/net/WorldApiClient';

function buildCtx(navOverrides: Partial<Nav>): {
  ctx: AppCtx;
  getFamilyCb: () => FamilySceneCallbacks;
  getSectCb: () => SectSceneCallbacks;
  getWorldMapOpened: () => boolean;
} {
  let familyCb: FamilySceneCallbacks | null = null;
  let sectCb: SectSceneCallbacks | null = null;
  let worldMapOpened = false;

  const storage = {
    getItem: (): string | null => 'acc_test',
    setItem: (): void => {},
    removeItem: (): void => {},
  };

  const views = {
    showFamily: (cb: FamilySceneCallbacks) => { familyCb = cb; },
    showSect: (cb: SectSceneCallbacks) => { sectCb = cb; return { applySectMsg() {} }; },
    showWorldMap: () => {
      worldMapOpened = true;
      return { applyMarchUpdate() {}, applyTileUpdate() {}, applyUnderAttack() {}, applySiegeResult() {} };
    },
  } as unknown as AppViews;

  const nav: Nav = {
    goFriends: vi.fn(),
    ...navOverrides,
  } as unknown as Nav;

  const ctx: AppCtx = {
    platform: { storage } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as AppCtx['api'],
    baseUrl: null,
    saveManager: { get: () => ({ wallet: { coins: 0 } }) } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: {} as unknown as AppState,
    nav,
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
    getFamilyCb: () => { if (!familyCb) throw new Error('views.showFamily was not called'); return familyCb; },
    getSectCb: () => { if (!sectCb) throw new Error('views.showSect was not called'); return sectCb; },
    getWorldMapOpened: () => worldMapOpened,
  };
}

const worldApi = {} as unknown as WorldApiClient;

describe('goFamilyHub — onNavTab', () => {
  it('clicking "sect" opens the sect hub with the same onExit', () => {
    const onExit = vi.fn();
    const { ctx, getFamilyCb, getSectCb } = buildCtx({});
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0', onExit);
    getFamilyCb().onNavTab('sect');

    const sectCb = getSectCb();
    sectCb.onBack();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('clicking "family" (its own tab) is a no-op', () => {
    const onExit = vi.fn();
    const goFriends = vi.fn();
    const { ctx, getFamilyCb } = buildCtx({ goFriends });
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0', onExit);
    getFamilyCb().onNavTab('family');

    expect(goFriends).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it.each(['friends', 'world', 'mail'] as const)('clicking "%s" delegates to nav.goFriends with defaultTab + the same onExit', (tab) => {
    const onExit = vi.fn();
    const goFriends = vi.fn();
    const { ctx, getFamilyCb } = buildCtx({ goFriends });
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0', onExit);
    getFamilyCb().onNavTab(tab);

    expect(goFriends).toHaveBeenCalledTimes(1);
    const [opts] = goFriends.mock.calls[0]!;
    expect(opts.defaultTab).toBe(tab);
    opts.onBack();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('onBack defaults to the world map when no onExit is passed (back-compat)', () => {
    const { ctx, getFamilyCb, getWorldMapOpened } = buildCtx({});
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0'); // no onExit
    getFamilyCb().onBack();

    expect(getWorldMapOpened()).toBe(true);
  });
});

describe('goSectHub — onNavTab', () => {
  it('clicking "family" opens the family hub with the same onExit', () => {
    const onExit = vi.fn();
    const { ctx, getSectCb, getFamilyCb } = buildCtx({});
    const { goSectHub } = createWorldNav(ctx);

    goSectHub(worldApi, 'world:1:0', onExit);
    getSectCb().onNavTab('family');

    const familyCb = getFamilyCb();
    familyCb.onBack();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('clicking "sect" (its own tab) is a no-op', () => {
    const onExit = vi.fn();
    const goFriends = vi.fn();
    const { ctx, getSectCb } = buildCtx({ goFriends });
    const { goSectHub } = createWorldNav(ctx);

    goSectHub(worldApi, 'world:1:0', onExit);
    getSectCb().onNavTab('sect');

    expect(goFriends).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('onBack no longer hardcodes a step back to the family hub — it exits to the same onExit as the rail', () => {
    // Pre-fix behavior was `onBack() { goFamilyHub(...) }` unconditionally. Now that SectScene
    // has its own rail with a working "family" tab for that, the header back button should
    // consistently exit the whole social hub, matching FriendsScene's own back semantics.
    const onExit = vi.fn();
    const { ctx, getSectCb } = buildCtx({});
    const { goSectHub } = createWorldNav(ctx);

    goSectHub(worldApi, 'world:1:0', onExit);
    getSectCb().onBack();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('onBack defaults to the world map when no onExit is passed (back-compat)', () => {
    const { ctx, getSectCb, getWorldMapOpened } = buildCtx({});
    const { goSectHub } = createWorldNav(ctx);

    goSectHub(worldApi, 'world:1:0'); // no onExit
    getSectCb().onBack();

    expect(getWorldMapOpened()).toBe(true);
  });
});
