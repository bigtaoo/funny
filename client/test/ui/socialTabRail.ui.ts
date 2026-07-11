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
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { marginLineX } from '../../src/render/sketchUi';

import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { WorldApiClient, FamilyDetailView, SectDetailView } from '../../src/net/WorldApiClient';
import type { SocialTab } from '../../src/render/socialTabRail';

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
  memberCount: 1, prosperity: 0, members: [],
};

const SECT_FIXTURE: SectDetailView = {
  sectId: 'sect_1', worldId: 'world:1:0', name: 'Silk Road', tag: 'SLK',
  leaderFamilyId: 'fam_1', leaderId: 'acc_test', memberFamilyCount: 1,
  allySectIds: [], prosperity: 0, memberFamilies: [],
};

// TAB_DEFS order in socialTabRail.ts — used to compute each cell's click point directly
// through the scene's real input path (handleDown), same as a live pointer tap would.
const TAB_ORDER: SocialTab[] = ['friends', 'family', 'sect', 'world', 'mail'];

/** FamilyScene/SectScene rail sits under their static full-width header (`headerH`) and
 *  dispatches clicks through `handleDown`. */
function clickRailTab(scene: any, tab: SocialTab): void {
  const index = TAB_ORDER.indexOf(tab);
  const railW = marginLineX(scene.w);
  const top = scene.headerH as number;
  const cellH = Math.round((scene.h - top) / TAB_ORDER.length);
  const x = Math.round(railW / 2);
  const y = top + index * cellH + Math.round(cellH / 2);
  scene.handleDown(x, y);
}

/** FriendsScene has no `headerH` field — its rail sits under `bodyTop` and dispatches
 *  through the pointer-down/up click path (`onPointerDown` + `onPointerUp`), not `handleDown`. */
function clickFriendsRailTab(scene: any, tab: SocialTab): void {
  const index = TAB_ORDER.indexOf(tab);
  const railW = marginLineX(scene.w);
  const top = scene.bodyTop as number;
  const cellH = Math.round((scene.h - top) / TAB_ORDER.length);
  const x = Math.round(railW / 2);
  const y = top + index * cellH + Math.round(cellH / 2);
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
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    expect(calls).toEqual(TAB_ORDER);
    scene.destroy();
  });
});

describe('SectScene — social tab rail (onNavTab wiring)', () => {
  function build(onNavTab: (tab: SocialTab) => void): any {
    const scene: any = new SectScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onNavTab,
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    });
    scene.mode = 'mySect';
    scene.sect = SECT_FIXTURE;
    scene.render();
    return scene;
  }

  it('clicking a rail tab calls onNavTab with that tab id', () => {
    const calls: SocialTab[] = [];
    const scene = build((tab) => calls.push(tab));

    for (const tab of TAB_ORDER) clickRailTab(scene, tab);

    expect(calls).toEqual(TAB_ORDER);
    scene.destroy();
  });

  it("the sect scene's own tab bar (families/channel) still lives to the right of the rail and is unaffected", () => {
    const scene = build(() => {});
    // families/channel tab bar hit rects now start at `left` (marginLineX), not x=0 —
    // clicking mid-rail (x well inside the rail) must not accidentally hit them.
    scene.handleDown(Math.round(marginLineX(scene.w) / 2), scene.headerH + 10);
    expect(scene.activeTab).toBe('families'); // unchanged — rail click, not the local tab bar
    scene.destroy();
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
});
