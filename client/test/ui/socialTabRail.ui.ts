// Regression guard for "family/sect hub scenes had no social tab rail" (09.07.2026).
//
// Root cause: FriendsScene's family/sect tabs auto-jump straight to FamilyScene/SectScene
// once the player already belongs to one (see familyHubNavRace.ui.ts) — but those two full
// scenes never rendered FriendsScene's left-margin 5-tab rail (friends/family/sect/world/
// mail), so switching into them made the other 4 tabs visually vanish. Fixed by having all
// three scenes share render/socialTabRail.ts's drawSocialTabRail() and wiring a new
// FamilySceneCallbacks/SectSceneCallbacks.onNavTab(tab) for rail clicks.
//
// This file pins: (1) the rail renders in FamilyScene/SectScene's "already joined" mode,
// (2) clicking any of the 5 rail cells invokes onNavTab with the clicked tab id, and
// (3) FriendsScene's own rail (now routed through the same shared helper) still dispatches
// to switchTab correctly post-refactor.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui
import * as PIXI from 'pixi.js-legacy';
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { sidebarNavW, sidebarItemHeight } from '../../src/ui/widgets/HubTabs';

import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { WorldApiClient, FamilyDetailView, SectDetailView } from '../../src/net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../src/render/socialTabRail';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

function stubWorldApi(): WorldApiClient {
  return {} as unknown as WorldApiClient;
}

const FAMILY_FIXTURE: FamilyDetailView = {
  familyId: 'fam_1', name: 'Ink Guard', tag: 'ABC', leaderId: 'acc_test',
  memberCount: 1, prosperity: 0,
  // 'acc_test' (the scene's myAccountId below) is the leader — the sect tab is only shown to a
  // family leader or a family already in a sect (see socialTabRail.ts's `hidden` param), so a
  // fixture testing rail dispatch through the sect cell needs to actually satisfy that gate.
  members: [{ accountId: 'acc_test', role: 'leader', joinedAt: 0 }],
};

const SECT_FIXTURE: SectDetailView = {
  sectId: 'sect_1', worldId: 'world:1:0', name: 'Silk Road', tag: 'SLK',
  leaderFamilyId: 'fam_1', leaderId: 'acc_test', memberFamilyCount: 1,
  allySectIds: [], prosperity: 0, memberFamilies: [],
};

// TAB_DEFS order in socialTabRail.ts — used to compute each cell's click point directly
// through the scene's real input path (handleDown), same as a live pointer tap would.
const TAB_ORDER: SocialTab[] = ['friends', 'family', 'sect', 'world', 'mail'];

// Cells stack with a small gap (HubTabs.ts's `drawSidebarTabs`, not exported since it's an internal
// layout constant) between fixed-height `sidebarItemHeight` cells — no longer a stretch-to-fill
// `(h - top) / 5` split (see 09adf922, which switched the rail's cell layout to match every other
// hub's fixed cell size, leaving the rail short of the full available height).
function railCellPitch(h: number): number {
  return sidebarItemHeight(h) + Math.round(h * 0.015);
}

/** FamilyScene/SectScene rail sits under their static full-width header (`headerH`) and
 *  dispatches clicks through `handleDown` + `handleUp` — the hit action fires on pointer-up now
 *  (ScrollTapGesture defers taps so a drag scrolls the body instead of firing a rail tab). */
function clickRailTab(scene: any, tab: SocialTab): void {
  const index = TAB_ORDER.indexOf(tab);
  const railW = sidebarNavW(scene.w, scene.h, scene.landscape);
  const top = scene.headerH as number;
  const pitch = railCellPitch(scene.h);
  const x = Math.round(railW / 2);
  const y = top + index * pitch + Math.round(sidebarItemHeight(scene.h) / 2);
  scene.handleDown(x, y);
  scene.handleUp(x, y);
}

/** FriendsScene has no `headerH` field — its rail sits under `bodyTop` and dispatches
 *  through the pointer-down/up click path (`onPointerDown` + `onPointerUp`), not `handleDown`. */
function clickFriendsRailTab(scene: any, tab: SocialTab): void {
  const index = TAB_ORDER.indexOf(tab);
  const railW = sidebarNavW(scene.w, scene.h, scene.landscape);
  const top = scene.bodyTop as number;
  const pitch = railCellPitch(scene.h);
  const x = Math.round(railW / 2);
  const y = top + index * pitch + Math.round(sidebarItemHeight(scene.h) / 2);
  scene.onPointerDown(x, y);
  scene.onPointerUp(x, y);
}

describe('FamilyScene — social tab rail (onNavTab wiring)', () => {
  function build(onNavTab: (tab: SocialTab) => void): any {
    const scene: any = new FamilyScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab,
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    });
    scene.mode = 'myFamily';
    scene.family = FAMILY_FIXTURE;
    scene.members = [];
    scene.render();
    return scene;
  }

  it('clicking a rail tab calls onNavTab with that tab id', () => {
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));

    clickRailTab(scene, 'friends');
    clickRailTab(scene, 'sect');
    clickRailTab(scene, 'world');
    clickRailTab(scene, 'mail');

    expect(calls).toEqual(['friends', 'sect', 'world', 'mail']);
    scene.destroy();
  });

  it('the other 4 tabs are still drawn (rail hit rects exist) while family info is showing', () => {
    // Regression check for the actual reported bug: before this fix, FamilyScene had no
    // rail hit rects at all, so every one of these clicks would have been silent no-ops.
    // 'family' itself is excluded: since 09adf922 moved the rail onto the shared
    // drawSidebarTabs convention, the active cell gets no hit rect at all (matching every
    // other hub's tab bar), so clicking it is a no-op rather than a redundant onNavTab call.
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    expect(calls).toEqual(TAB_ORDER.filter((tab) => tab !== 'family'));
    scene.destroy();
  });

  it('the other 4 tabs are still drawn while the player has no family yet (noFamily mode)', () => {
    // Regression check for "点击sect/family页签时，其他页签消失了" (12.07.2026): the rail used
    // to be drawn only from renderMyFamily(), so as soon as the scene landed in 'noFamily'
    // (or stayed in 'loading') — which it does for any account without a family, or briefly
    // for every account while loadData() is in flight — the rail vanished entirely, not just
    // its own active cell. Fixed by moving the drawSocialTabRail() call into the shared
    // render() dispatcher (base.ts) so it runs for every mode.
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));
    scene.mode = 'noFamily';
    scene.family = null;
    scene.render();

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    // 'sect' is also excluded here: with no family at all, the player is neither a family
    // leader nor already in a sect, so socialTabRail.ts's `hidden` gate drops the sect cell.
    expect(calls).toEqual(TAB_ORDER.filter((tab) => tab !== 'family' && tab !== 'sect'));
    scene.destroy();
  });
});

describe('SectScene — social tab rail (onNavTab wiring)', () => {
  function build(onNavTab: (tab: SocialTab) => void): any {
    const scene: any = new SectScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onNavTab,
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
      getCoins: () => 100000, refreshWallet: async () => {},
    });
    scene.mode = 'mySect';
    scene.sect = SECT_FIXTURE;
    scene.render();
    return scene;
  }

  it('clicking a rail tab calls onNavTab with that tab id', () => {
    // 'sect' is the active tab here (see SectScene/render.ts), so — like FamilyScene's
    // 'family' above — it gets no hit rect and is excluded from the expected calls.
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    expect(calls).toEqual(TAB_ORDER.filter((tab) => tab !== 'sect'));
    scene.destroy();
  });

  it("the sect scene's own tab bar (families/channel) still lives to the right of the rail and is unaffected", () => {
    const scene = build(() => {});
    // families/channel tab bar hit rects now start at `left` (sidebarNavW), not x=0 —
    // clicking mid-rail (x well inside the rail) must not accidentally hit them.
    scene.handleDown(Math.round(sidebarNavW(scene.w, scene.h, scene.landscape) / 2), scene.headerH + 10);
    expect(scene.activeTab).toBe('families'); // unchanged — rail click, not the local tab bar
    scene.destroy();
  });

  it('the other 4 tabs are still drawn while the player has no sect yet (noSect mode)', () => {
    // Regression check for "点击sect页签时，其他页签消失了" (12.07.2026): the rail used to be
    // drawn only from renderMySect(), so any account without a sect — or any account while
    // loadData() is still in flight — landed in a mode that rendered no rail at all. Fixed by
    // moving the drawSocialTabRail() call into the shared render() dispatcher (base.ts).
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));
    scene.mode = 'noSect';
    scene.sect = null;
    scene.inFamily = true;
    scene.myFamilyRole = 'leader';
    scene.render();

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    expect(calls).toEqual(TAB_ORDER.filter((tab) => tab !== 'sect'));
    scene.destroy();
  });
});

// drawSocialTabRail's `hidden` param, tested directly rather than by simulating pixel clicks —
// in SectScene the active tab is *always* 'sect' (see SectSceneBase.render()), so a hidden-vs-
// active-but-visible cell can't be told apart through the rendered scene's click geometry alone
// (both leave 'sect' un-clickable, and clicking-all-5-fixed-slots happens to land on the same
// aggregate set of onNavTab calls either way — a hidden cell just closes the layout gap one slot
// earlier). Calling the exported hits directly sidesteps that ambiguity entirely.
describe('drawSocialTabRail — hidden param (13.07.2026: sect tab hidden for non-leader/no-sect)', () => {
  /** Draws the rail once, clicks every returned hit in order, and returns the tab ids that fired. */
  function clickableTabs(active: SocialTab, hidden: SocialTab[] = []): SocialTab[] {
    const container = new PIXI.Container();
    const selected: SocialTab[] = [];
    const hits = drawSocialTabRail(container, W, H, 0, false, active, {}, (t) => selected.push(t), hidden);
    hits.forEach((h) => h.fn());
    return selected;
  }

  it('with nothing hidden, every tab except the active one is clickable', () => {
    expect(clickableTabs('friends')).toEqual(['family', 'sect', 'world', 'mail']);
  });

  it('a hidden tab is entirely absent from the clickable set, even when it is not the active tab', () => {
    expect(clickableTabs('friends', ['sect'])).toEqual(['family', 'world', 'mail']);
  });

  it('a hidden tab that also happens to be the active tab is not double-excluded', () => {
    // SectScene's own case: active='sect' AND hidden=['sect'] together — must behave exactly
    // like hiding it while some other tab is active, not remove an extra slot.
    expect(clickableTabs('sect', ['sect'])).toEqual(['friends', 'family', 'world', 'mail']);
  });

  it('hiding multiple tabs at once removes both from the clickable set', () => {
    expect(clickableTabs('friends', ['sect', 'world'])).toEqual(['family', 'mail']);
  });
});

describe('FriendsScene — social tab rail still dispatches to switchTab after sharing drawSocialTabRail', () => {
  function build(): any {
    return new FriendsScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {},
      respond: async () => {},
      removeFriend: async () => {},
      blockUser: async () => {},
      loadConversations: async () => [],
      openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }),
      markMailRead: async () => {},
      claimMail: async () => true,
      deleteMail: async () => {},
      // No family/sect membership yet → clicking those tabs shows the inline
      // create/join forms instead of auto-navigating away (see orgForm.ts).
      loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
      openFamilyHub() {},
      openSectHub() {},
    });
  }

  it('clicking each rail tab switches scene.tab accordingly', () => {
    const scene = build();
    for (const tab of TAB_ORDER) {
      clickFriendsRailTab(scene, tab);
      expect(scene.tab).toBe(tab);
    }
    scene.destroy();
  });

  it('sect tab is unclickable for a non-leader whose family has no sect (13.07.2026)', () => {
    // The sect cell is entirely removed from the rail layout (not just left without a hit
    // rect), so every other cell after it shifts up by one slot — clicking through all 5
    // fixed rail positions can therefore never land on 'sect' itself, even though the clicks
    // that used to hit 'sect'/'world' now hit whatever shifted into that slot instead.
    const scene = build();
    scene.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1' };
    scene.render();

    const seenTabs: string[] = [];
    for (const tab of TAB_ORDER) {
      clickFriendsRailTab(scene, tab);
      seenTabs.push(scene.tab);
    }

    expect(seenTabs).not.toContain('sect');
    // the other tabs remain reachable through the (shifted) rail.
    expect(seenTabs).toContain('family');
    expect(seenTabs).toContain('world');
    expect(seenTabs).toContain('mail');
    scene.destroy();
  });

  it('sect tab is clickable for a family leader, even with no sect yet', () => {
    const scene = build();
    scene.slgStatus = { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1' };
    scene.render();

    clickFriendsRailTab(scene, 'sect');
    expect(scene.tab).toBe('sect');
    scene.destroy();
  });

  it('sect tab is clickable for a non-leader whose family already belongs to a sect', () => {
    const scene = build();
    scene.slgStatus = { worldId: 'world:1:0', isLeader: false, familyId: 'fam_1', sectId: 'sect_1' };
    scene.render();

    clickFriendsRailTab(scene, 'sect');
    expect(scene.tab).toBe('sect');
    scene.destroy();
  });
});
