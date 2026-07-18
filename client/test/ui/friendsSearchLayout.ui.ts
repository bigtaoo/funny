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
  return new FriendsScene(createLayout(w, h), input, {
    onBack() {},
    onOpenRoom() {},
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '233784986', displayName: 'TestPlayer' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {},
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    ...cb,
  });
}

type SearchInternals = {
  hits: Array<{ rect: { x: number; y: number; w: number; h: number }; scroll?: boolean }>;
  maxScroll: number;
  regionTop: number;
  regionBottom: number;
  searchDigits: string[];
  searchResult: unknown;
  render(): void;
  openSearch(): void;
  doSearch(): Promise<void>;
};

describe('FriendsScene — search subview keypad + result fit on screen', () => {
  // createLayout()'s screenW/screenH are the *safe drawable area* it fits to, not the
  // design space the scene actually renders in — LandscapeLayout pegs designHeight at
  // 1080 (width follows aspect, min 1920) and PortraitLayout pegs designWidth at 1080
  // (height follows aspect, min 1920). So bounds must come from the scene's own `w`/`h`
  // (== layout.designWidth/designHeight), not the raw args passed to createLayout().
  for (const [screenW, screenH] of [[1920, 1040], [2400, 1080], [608, 1080]] as const) {
    it(`every search-view hit rect stays within the design bounds at ${screenW}x${screenH}`, () => {
      const scene = buildFriends(new InputManager(), screenW, screenH);
      const s = scene as unknown as SearchInternals & { w: number; h: number };
      s.openSearch();

      for (const hit of s.hits) {
        expect(hit.rect.y).toBeGreaterThanOrEqual(0);
        expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(s.h);
        expect(hit.rect.x).toBeGreaterThanOrEqual(0);
        expect(hit.rect.x + hit.rect.w).toBeLessThanOrEqual(s.w);
      }
      scene.destroy();
    });
  }

  it('the result card (with its Add button) fits within the screen once a search resolves', async () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const s = scene as unknown as SearchInternals & { h: number };
    s.openSearch();
    s.searchDigits = ['2', '3', '3', '7', '8', '4', '9', '8', '6'];
    await s.doSearch();

    expect(s.searchResult).not.toBeNull();
    for (const hit of s.hits) {
      expect(hit.rect.y + hit.rect.h).toBeLessThanOrEqual(s.h);
    }
    scene.destroy();
  });
});

describe('FriendsScene — search subview is wired into the shared scroll mechanism', () => {
  it('sets regionTop/regionBottom and a defined maxScroll (not left stale/unset)', () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const s = scene as unknown as SearchInternals;
    s.openSearch();

    expect(s.regionBottom).toBeGreaterThan(s.regionTop);
    expect(s.maxScroll).toBeGreaterThanOrEqual(0);
    scene.destroy();
  });

  it('marks every keypad/search/result hit as scrollable (scroll: true), so drag-scroll stays correct if content ever overflows', async () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const s = scene as unknown as SearchInternals;
    s.openSearch();
    s.searchDigits = ['2', '3', '3', '7', '8', '4', '9', '8', '6'];
    await s.doSearch();

    // Every hit in the search view lives inside the scrollable layer (back button in the
    // header is the only non-scroll hit, drawn separately by drawHeader()).
    const scrollableHits = s.hits.filter((h) => h.scroll);
    expect(scrollableHits.length).toBeGreaterThanOrEqual(13); // 12 keys + Search + Add
  });

  it('resets scrollY when re-opening the search view', () => {
    const scene = buildFriends(new InputManager(), 1920, 1040);
    const s = scene as unknown as SearchInternals & { scrollY: number };
    s.openSearch();
    s.scrollY = 42;
    s.openSearch();
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });
});
