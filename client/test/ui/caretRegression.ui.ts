// Regression guard for the "input field loses its blinking cursor" bug class.
//
// Root cause (see 04.07.2026 investigation): several canvas-rendered text-input
// fields concatenate the raw string directly (`txt(this.value || ' ', ...)`)
// instead of routing through the shared `caretDisplay()` helper (fixed once
// already for ShopScene/SettingsScene/ChatScene in d2135568, 2026-06-23). Any
// field that skips `caretDisplay` never draws the '|' cursor glyph at all, no
// matter how long the field stays focused.
//
// This file exercises every hidden-DOM-input-backed field in the codebase and
// asserts the rendered PIXI.Text actually contains '|' while focused+blink-on,
// and does NOT contain it while blink-off (falling back to text/placeholder).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts) — real display objects, no renderer/WebGL. Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

import { LoginScene } from '../../src/scenes/LoginScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import type { WorldApiClient } from '../../src/net/WorldApiClient';

// Minimal DOM stub so openHiddenInput() (document.createElement / body.appendChild /
// element.focus) runs under the plain-Node headless harness. Only the members the input
// helper touches are provided.
const gDoc = globalThis as unknown as { document?: unknown };
if (!gDoc.document) {
  gDoc.document = {
    body: { appendChild(): void {} },
    createElement(): Record<string, unknown> {
      return {
        type: '', value: '', maxLength: 0, placeholder: '', autocomplete: '',
        style: { cssText: '' },
        parentNode: null,
        focus(): void {},
        remove(): void {},
        setAttribute(): void {},
        addEventListener(): void {},
      };
    },
  };
}

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

/** Minimal WorldApiClient stub. Any unlisted method throws synchronously if
 *  called, which the scenes' loadData() try/catch already tolerates. Exception:
 *  the auction create-form's ref-band fetch (de5832ba) fires inside openCreateForm,
 *  OUTSIDE loadData's try/catch, so getAuctionRefBand must be stubbed or the caret
 *  test throws before it can assert (mirrors auctionScene.ui.ts's stub). */
function stubWorldApi(): WorldApiClient {
  return {
    getAuctionRefBand: async () => ({ ref: 10, floor: 5, ceil: 20 }),
  } as unknown as WorldApiClient;
}

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/** Asserts a scene's current render shows a caret when blink is on, and hides
 *  it when blink is off — the exact contract `caretDisplay()` provides. */
function expectBlinkingCaret(
  container: PIXI.Container,
  setCaret: (on: boolean) => void,
  rerender: () => void,
  expectedWithCaret: string,
): void {
  setCaret(true);
  rerender();
  expect(collectTexts(container)).toContain(expectedWithCaret);

  setCaret(false);
  rerender();
  expect(collectTexts(container)).not.toContain(expectedWithCaret);
}

describe('FamilyScene — create-form caret', () => {
  function build(): any {
    return new FamilyScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab() {}, async addFriend() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    });
  }

  it('name field shows a blinking cursor while focused and empty', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = 'name';
    scene.createName = '';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), '|');
    scene.destroy();
  });

  it('name field shows a blinking cursor appended to typed text', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = 'name';
    scene.createName = 'MyFamily';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'MyFamily|');
    scene.destroy();
  });

  it('tag field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = 'tag';
    scene.createTag = 'AB';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'AB|');
    scene.destroy();
  });

  it('unfocused fields never show a cursor regardless of blink phase', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = null;
    scene.createName = 'MyFamily';
    scene.caretOn = true;
    scene.render();
    expect(collectTexts(scene.container)).not.toContain('MyFamily|');
    scene.destroy();
  });
});

describe('SectScene — create-form caret', () => {
  function build(): any {
    return new SectScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onNavTab() {}, worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
      getCoins: () => 100000, refreshWallet: async () => {},
    });
  }

  it('name field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = 'name';
    scene.createName = 'MySect';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'MySect|');
    scene.destroy();
  });

  it('tag field shows a blinking cursor while focused and empty', () => {
    const scene = build();
    scene.mode = 'create';
    scene.createField = 'tag';
    scene.createTag = '';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), '|');
    scene.destroy();
  });
});

describe('FriendsScene — family/sect/world tab carets', () => {
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
      // SLG tabs reachable — status has neither familyId nor sectId, so each tab
      // lands on its create/join subview rather than the "you're already in one" view.
      loadSLGStatus: async () => null,
      loadWorldChat: async () => [],
      sendWorldChat: async () => {},
    });
  }

  function enterSlgTab(scene: any, tab: 'family' | 'sect' | 'world'): void {
    scene.tab = tab;
    scene.slgLoaded = true;
    // drawFamilyTab shows the create/join subview only when familyId is unset (no
    // family yet). drawSectTab requires the OPPOSITE — familyId set (you must be in
    // a family before you can join/create a sect) plus isLeader to reach 'create'.
    scene.slgStatus = tab === 'sect'
      ? { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1' }
      : { worldId: 'world:1:0', isLeader: false };
    scene.render();
  }

  it('family create-form name field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.familySubview = 'create';
    scene.familyActiveInput = 'name';
    scene.familyCreateName = 'MyFamily';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'MyFamily|');
    scene.destroy();
  });

  it('family create-form tag field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.familySubview = 'create';
    scene.familyActiveInput = 'tag';
    scene.familyCreateTag = 'AB';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'AB|');
    scene.destroy();
  });

  it('family join-search field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.familySubview = 'joinById';
    scene.familyActiveInput = 'search';
    scene.familyBrowseQuery = 'Fam';
    scene.familyBrowseLoaded = true;
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'Fam|');
    scene.destroy();
  });

  it('sect create-form name field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.sectSubview = 'create';
    scene.sectActiveInput = 'name';
    scene.sectCreateName = 'MySect';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'MySect|');
    scene.destroy();
  });

  it('sect create-form tag field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.sectSubview = 'create';
    scene.sectActiveInput = 'tag';
    scene.sectCreateTag = 'CD';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'CD|');
    scene.destroy();
  });

  it('sect join-by-id field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.sectSubview = 'joinById';
    scene.sectActiveInput = 'id';
    scene.sectJoinId = 'sect_9';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'sect_9|');
    scene.destroy();
  });

  it('world channel input shows a blinking cursor while active', () => {
    const scene = build();
    enterSlgTab(scene, 'world');
    scene.worldChatActive = true;
    scene.worldChatInput = 'hello';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'hello|');
    scene.destroy();
  });

  // Regression (the real bug the manual-state tests above missed): tapping the field must
  // LEAVE it active. openHiddenInput() used to call clearHiddenInput() as its first line,
  // which reset the very flag the tap handler had just set → the caret never appeared in
  // real use even though every manual-state assertion passed. Exercise the actual hit path.
  it('tapping the world input keeps it active and shows the caret (openHiddenInput must not clear the flag)', () => {
    const scene = build();
    enterSlgTab(scene, 'world');
    scene.render();
    // The input hit is the wide field pinned to the bottom of the content column; the send
    // button sits to its right. Exclude the vertical tab rail (x === 0, left of the binding
    // line) so "leftmost bottom hit" resolves to the input field, not a rail cell.
    const hits = scene.hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
    const bottom = hits.filter((hh) => hh.rect.y > H * 0.8 && hh.rect.x > 0);
    const inputHit = bottom.reduce((a, b) => (b.rect.x < a.rect.x ? b : a));
    inputHit.fn(); // simulate the tap

    expect(scene.worldChatActive).toBe(true);
    scene.caretOn = true;
    scene.render();
    expect(collectTexts(scene.container)).toContain('|'); // empty field + blink-on → caret alone
    scene.destroy();
  });
});

describe('AuctionScene — designated-buyer field caret', () => {
  function build(): any {
    return new AuctionScene(createLayout(W, H), new InputManager(), {
      onBack() {}, worldApi: stubWorldApi(),
    });
  }

  it('buyer field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.buyerActive = true;
    scene.createBuyer = 'acc_42';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.openCreateForm(), 'acc_42|');
    scene.destroy();
  });

  it('buyer field shows a blinking cursor while focused and empty (falls back to caret, not placeholder)', () => {
    const scene = build();
    scene.buyerActive = true;
    scene.createBuyer = '';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.openCreateForm(), '|');
    scene.destroy();
  });

  it('unfocused buyer field never shows a cursor', () => {
    const scene = build();
    scene.buyerActive = false;
    scene.createBuyer = 'acc_42';
    scene.caretOn = true;
    scene.openCreateForm();
    expect(collectTexts(scene.container)).not.toContain('acc_42|');
    scene.destroy();
  });
});

describe('LoginScene — email/password field caret (already-correct baseline)', () => {
  function build(): any {
    return new LoginScene(createLayout(W, H), new InputManager(), {
      onLogin: async () => ({ ok: true }),
      onRegister: async () => ({ ok: true }),
      onPlayOffline() {},
    });
  }

  it('the focused loginId field shows a blinking cursor', () => {
    const scene = build();
    scene.view = 'password';
    scene.focused = 'loginId';
    scene.fields.loginId = 'tester';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'tester|');
    scene.destroy();
  });
});
