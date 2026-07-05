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
 *  called, which the scenes' loadData() try/catch already tolerates. */
function stubWorldApi(): WorldApiClient {
  return {} as unknown as WorldApiClient;
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
      onBack() {}, onOpenSect() {},
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
      onBack() {}, worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
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

  it('family join-by-id field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.familySubview = 'joinById';
    scene.familyActiveInput = 'id';
    scene.familyJoinId = 'fam_123';
    expectBlinkingCaret(scene.container, (on) => { scene.caretOn = on; }, () => scene.render(), 'fam_123|');
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
});

describe('AuctionScene — designated-buyer field caret', () => {
  function build(): any {
    return new AuctionScene(createLayout(W, H), new InputManager(), {
      onBack() {}, worldApi: stubWorldApi(), worldId: 'world:1:0',
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
