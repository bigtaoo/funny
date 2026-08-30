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
import type { FamilySceneCallbacks, FamilySceneView } from '../src/scenes/FamilyScene';
import type { SectSceneCallbacks, SectSceneView } from '../src/scenes/SectScene';
import type { FamilyDetailView, SectDetailView, WorldApiClient } from '../src/net/WorldApiClient';

function buildCtx(navOverrides: Partial<Nav>): {
  ctx: AppCtx;
  getFamilyCb: () => FamilySceneCallbacks;
  getSectCb: () => SectSceneCallbacks;
  getWorldMapOpened: () => boolean;
  /** What the mounted FamilyScene/SectScene report as already-loaded (see FamilySceneView/
   *  SectSceneView.getFamily/getSect) — set these before a cross-hub onNavTab call to assert what
   *  goFamilyHub/goSectHub hand the sibling hub as preloadedFamily/preloadedSect. */
  setFamilyDetail: (fam: FamilyDetailView | null) => void;
  setSectDetail: (sect: SectDetailView | null) => void;
} {
  let familyCb: FamilySceneCallbacks | null = null;
  let sectCb: SectSceneCallbacks | null = null;
  let worldMapOpened = false;
  let familyDetail: FamilyDetailView | null = null;
  let sectDetail: SectDetailView | null = null;

  const storage = {
    getItem: (): string | null => 'acc_test',
    setItem: (): void => {},
    removeItem: (): void => {},
  };

  const views = {
    showFamily: (cb: FamilySceneCallbacks): FamilySceneView => {
      familyCb = cb;
      return { applyFamilyMsg() {}, getFamily: () => familyDetail };
    },
    showSect: (cb: SectSceneCallbacks): SectSceneView => {
      sectCb = cb;
      return { applySectMsg() {}, getFamily: () => familyDetail, getSect: () => sectDetail };
    },
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
    setFamilyDetail: (fam) => { familyDetail = fam; },
    setSectDetail: (sect) => { sectDetail = sect; },
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

  it('clicking "sect" hands SectScene the family FamilyScene already loaded, as preloadedFamily (social-tab-switch-cost)', () => {
    // Regression for the flicker report (30.08.2026): the cross-hub hop used to open SectScene with
    // no preload at all, forcing it through a full getMyFamily() (+ getSect()) round-trip and a
    // visible 'loading' skeleton before painting real content — unlike Friends<->Mail, which never
    // leave FriendsScene and never show a loading flash. SectScene should get the family for free.
    const { ctx, getFamilyCb, getSectCb, setFamilyDetail } = buildCtx({});
    const fam = { familyId: 'f1', sectId: 's1' } as unknown as FamilyDetailView;
    setFamilyDetail(fam);
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0', vi.fn());
    getFamilyCb().onNavTab('sect');

    expect(getSectCb().preloadedFamily).toBe(fam);
  });

  it('tapping "查看宗门" (onOpenSect) gets the same preloadedFamily hand-off as the rail tab', () => {
    const { ctx, getFamilyCb, getSectCb, setFamilyDetail } = buildCtx({});
    const fam = { familyId: 'f1', sectId: 's1' } as unknown as FamilyDetailView;
    setFamilyDetail(fam);
    const { goFamilyHub } = createWorldNav(ctx);

    goFamilyHub(worldApi, 'world:1:0', vi.fn());
    getFamilyCb().onOpenSect();

    expect(getSectCb().preloadedFamily).toBe(fam);
  });

  it('a sect this session already saw (via SectSceneCallbacks.onSectLoaded) is handed back as preloadedSect on a later Family->Sect hop', () => {
    const { ctx, getFamilyCb, getSectCb, setFamilyDetail, setSectDetail } = buildCtx({});
    const fam = { familyId: 'f1', sectId: 's1' } as unknown as FamilyDetailView;
    const sect = { sectId: 's1' } as unknown as SectDetailView;
    setFamilyDetail(fam);
    const { goFamilyHub } = createWorldNav(ctx);

    // First hop: no sect known yet, so preloadedSect is absent.
    goFamilyHub(worldApi, 'world:1:0', vi.fn());
    getFamilyCb().onNavTab('sect');
    expect(getSectCb().preloadedSect).toBeUndefined();

    // SectScene "loads" (via preloadedFamily above) and reports the sect back.
    getSectCb().onSectLoaded?.(sect);
    setSectDetail(sect);

    // Second hop (as if the player bounced back to Family and tapped Sect again): now cached.
    goFamilyHub(worldApi, 'world:1:0', vi.fn());
    getFamilyCb().onNavTab('sect');
    expect(getSectCb().preloadedSect).toBe(sect);
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

  it('clicking "family" hands FamilyScene the family SectScene already loaded, as preloadedFamily — zero re-fetch (social-tab-switch-cost)', () => {
    // SectScene already holds the full FamilyDetailView (SectSceneCore.family) since sect
    // membership hangs off family, so this direction needs no network round-trip at all, unlike
    // Family->Sect (which still needs one getSect() the very first time — see the mirror test above).
    const { ctx, getSectCb, getFamilyCb, setFamilyDetail } = buildCtx({});
    const fam = { familyId: 'f1', sectId: 's1' } as unknown as FamilyDetailView;
    setFamilyDetail(fam);
    const { goSectHub } = createWorldNav(ctx);

    goSectHub(worldApi, 'world:1:0', vi.fn());
    getSectCb().onNavTab('family');

    expect(getFamilyCb().preloadedFamily).toBe(fam);
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
