// Regression coverage for FriendsScene's "Find a player" (search) subview.
// Bug: the numeric keypad used a WIDTH-based gap (kGap = w*0.03) as the VERTICAL
// spacing between key rows, which on wide/landscape screens blew the whole
// column (field + 4 key rows + Search button + result card) far past the
// bottom edge — the Search button and result card rendered off-screen. Worse,
// the subview never wired into the shared scrollRegion/scrollY mechanism
// (drawSearch drew straight to this.container with no `layer`, no
// regionTop/regionBottom, maxScroll left at 0), so there was no way to
// scroll down to reach them either.
//
// Fix: shrink the keypad, use an independent height-based row gap, and route
// everything below the title through the same scrollRegion()/screenY()/
// maxScroll pattern the friends list and mail tabs already use.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildFriends(
  input: InputManager,
  w: number,
  h: number,
  cb: Partial<FriendsSceneCallbacks> = {},
): FriendsScene {
  const { openTextInput } = createFakeTextInput();
  return new FriendsScene(createLayout(w, h), input, {
    onBack() {},
    onOpenRoom() {},
    openTextInput,
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '233784986', displayName: 'TestPlayer' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    ...cb,
  });
}

/** Reach FriendsScene's composed `core`/`search`/`network` fields (2026-08-11 composition
 *  conversion — see claudedocs/client-modules.md's split-form priority note): state (hits/
 *  maxScroll/regionTop/regionBottom/searchDigits/searchResult/w/h/scrollY/render) lives on `core`;
 *  openSearch on the SearchPanel instance; doSearch on the NetworkPanel instance. */
function internals(scene: FriendsScene): {
  core: {
    hits: Array<{ rect: { x: number; y: number; w: number; h: number }; scroll?: boolean }>;
    maxScroll: number;
    regionTop: number;
    regionBottom: number;
    searchDigits: string[];
    searchResult: unknown;
    render(): void;
    w: number;
    h: number;
    scrollY: number;
  };
  search: { openSearch(): void };
  network: { doSearch(): Promise<void> };
} {
  return scene as unknown as ReturnType<typeof internals>;
}

describe('FriendsScene — search subview keypad + result fit on screen', () => {
  // createLayout()'s screenW/screenH are the *safe drawable area* it fits to, not the
  // design space the scene actually renders in — LandscapeLayout pegs designHeight at
  // 1080 (width follows aspect, min 1920) and PortraitLayout pegs designWidth at 1080
  // (height follows aspect, min 1920). So bounds must come from the scene's own `w`/`h`
  // (== layout.designWidth/designHeight), not the raw args passed to createLayout().
  for (const [screenW, screenH] of [[1920, 1040], [2400, 1080], [608, 1080]] as const) {
    it(`every search-view hit rect stays within the design bounds at ${screenW}x${screenH}`, () => {
      const scene = buildFriends(new InputManager(), screenW, screenH);
      const { core, search } = internals(scene);
      search.openSearch();

      for (const hit of core.hits) {
        expect(hit.rect.y).toBeGreaterThanOrEqual(0);
        expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(core.h);
        expect(hit.rect.x).toBeGreaterThanOrEqual(0);
        expect(hit.rect.x + hit.rect.w).toBeLessThanOrEqual(core.w);
      }
      scene.destroy();
    });
  }

  it('the result card (with its Add button) fits within the screen once a search resolves', async () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const { core, search, network } = internals(scene);
    search.openSearch();
    core.searchDigits = ['2', '3', '3', '7', '8', '4', '9', '8', '6'];
    await network.doSearch();

    expect(core.searchResult).not.toBeNull();
    for (const hit of core.hits) {
      expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(core.h);
    }
    scene.destroy();
  });
});

describe('FriendsScene — search subview is wired into the shared scroll mechanism', () => {
  it('sets regionTop/regionBottom and a defined maxScroll (not left stale/unset)', () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const { core, search } = internals(scene);
    search.openSearch();

    expect(core.regionBottom).toBeGreaterThan(core.regionTop);
    expect(core.maxScroll).toBeGreaterThanOrEqual(0);
    scene.destroy();
  });

  it('marks every keypad/search/result hit as scrollable (scroll: true), so drag-scroll stays correct if content ever overflows', async () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const { core, search, network } = internals(scene);
    search.openSearch();
    core.searchDigits = ['2', '3', '3', '7', '8', '4', '9', '8', '6'];
    await network.doSearch();

    // Every hit in the search view lives inside the scrollable layer (back button in the
    // header is the only non-scroll hit, drawn separately by drawHeader()).
    const scrollableHits = core.hits.filter((h) => h.scroll);
    expect(scrollableHits.length).toBeGreaterThanOrEqual(13); // 12 keys + Search + Add
  });

  it('resets scrollY when re-opening the search view', () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const { core, search } = internals(scene);
    search.openSearch();
    core.scrollY = 42;
    search.openSearch();
    expect(core.scrollY).toBe(0);
    scene.destroy();
  });
});
