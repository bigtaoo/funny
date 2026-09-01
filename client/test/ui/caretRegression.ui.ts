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
import { bottomNavH } from '../../src/ui/widgets/HubTabs';

import { LoginScene } from '../../src/scenes/LoginScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { FeedbackDialog } from '../../src/ui/dialogs/FeedbackDialog';
import { AppealDialog } from '../../src/ui/dialogs/AppealDialog';
import { ConsentDialog } from '../../src/ui/dialogs/ConsentDialog';
import { ReconnectPromptDialog } from '../../src/ui/dialogs/ReconnectPromptDialog';
import { ui as C } from '../../src/render/sketchUi';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { openDomTextInput } from '../../src/platform/web/domTextInput';

// Minimal DOM stub so the real openDomTextInput() (document.createElement / body.appendChild /
// element.focus — ASSET_PACKAGING §4.3/§4.4 item 1, wired into every scene below as
// `cb.openTextInput`) runs under the plain-Node headless harness. Only the members it touches are
// provided.
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
      openTextInput: openDomTextInput,
      onBack() {}, onOpenSect() {}, onNavTab() {}, async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
      openChat() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    });
  }

  it('name field shows a blinking cursor while focused and empty', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = 'name';
    scene.core.createName = '';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), '|');
    scene.destroy();
  });

  it('name field shows a blinking cursor appended to typed text', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = 'name';
    scene.core.createName = 'MyFamily';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'MyFamily|');
    scene.destroy();
  });

  it('tag field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = 'tag';
    scene.core.createTag = 'AB';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'AB|');
    scene.destroy();
  });

  it('unfocused fields never show a cursor regardless of blink phase', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = null;
    scene.core.createName = 'MyFamily';
    scene.core.caretOn = true;
    scene.render();
    expect(collectTexts(scene.container)).not.toContain('MyFamily|');
    scene.destroy();
  });
});

describe('SectScene — create-form caret', () => {
  function build(): any {
    return new SectScene(createLayout(W, H), new InputManager(), {
      openTextInput: openDomTextInput,
      onBack() {}, onNavTab() {}, worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
      getCoins: () => 100000, refreshWallet: async () => {},
    });
  }

  it('name field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = 'name';
    scene.core.createName = 'MySect';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'MySect|');
    scene.destroy();
  });

  it('tag field shows a blinking cursor while focused and empty', () => {
    const scene = build();
    scene.core.mode = 'create';
    scene.core.createField = 'tag';
    scene.core.createTag = '';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), '|');
    scene.destroy();
  });
});

describe('FriendsScene — family/sect/world tab carets', () => {
  function build(): any {
    return new FriendsScene(createLayout(W, H), new InputManager(), {
      openTextInput: openDomTextInput,
      onBack() {}, onOpenRoom() {},
      myPublicId: '',
      getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {},
      respond: async () => {},
      removeFriend: async () => {},
      blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
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
    scene.core.tab = tab;
    scene.core.slgLoaded = true;
    // drawFamilyTab shows the create/join subview only when familyId is unset (no
    // family yet). drawSectTab requires the OPPOSITE — familyId set (you must be in
    // a family before you can join/create a sect) plus isLeader to reach 'create'.
    scene.core.slgStatus = tab === 'sect'
      ? { worldId: 'world:1:0', isLeader: true, familyId: 'fam_1' }
      : { worldId: 'world:1:0', isLeader: false };
    scene.render();
  }

  it('family create-form name field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.core.familySubview = 'create';
    scene.core.familyActiveInput = 'name';
    scene.core.familyCreateName = 'MyFamily';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'MyFamily|');
    scene.destroy();
  });

  it('family create-form tag field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.core.familySubview = 'create';
    scene.core.familyActiveInput = 'tag';
    scene.core.familyCreateTag = 'AB';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'AB|');
    scene.destroy();
  });

  it('family join-search field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'family');
    scene.core.familySubview = 'joinById';
    scene.core.familyActiveInput = 'search';
    scene.core.familyBrowseQuery = 'Fam';
    scene.core.familyBrowseLoaded = true;
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'Fam|');
    scene.destroy();
  });

  it('sect create-form name field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.core.sectSubview = 'create';
    scene.core.sectActiveInput = 'name';
    scene.core.sectCreateName = 'MySect';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'MySect|');
    scene.destroy();
  });

  it('sect create-form tag field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.core.sectSubview = 'create';
    scene.core.sectActiveInput = 'tag';
    scene.core.sectCreateTag = 'CD';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'CD|');
    scene.destroy();
  });

  it('sect join-by-id field shows a blinking cursor', () => {
    const scene = build();
    enterSlgTab(scene, 'sect');
    scene.core.sectSubview = 'joinById';
    scene.core.sectActiveInput = 'id';
    scene.core.sectJoinId = 'sect_9';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'sect_9|');
    scene.destroy();
  });

  it('world channel input shows a blinking cursor while active', () => {
    const scene = build();
    enterSlgTab(scene, 'world');
    scene.core.worldChatActive = true;
    scene.core.worldChatInput = 'hello';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.render(), 'hello|');
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
    // button sits to its right. [W, H] = [800, 1280] is portrait, so the 5-tab social rail
    // (ui/widgets/socialTabRail.ts) renders as a bottom nav bar spanning the full width
    // (LOBBY_IA_REDESIGN.md §18/§20) rather than the old left sidebar — excluding just x === 0
    // no longer keeps it out of "leftmost bottom hit", since its cells span x>0 too. Exclude
    // anything at/below the nav bar's own top edge (bodyBottom already reserves bottomNavH
    // above it, so the input field itself sits clear of that band).
    const hits = scene.core.hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
    const navTop = scene.core.landscape ? Infinity : scene.core.h - bottomNavH(scene.core.h);
    const bottom = hits.filter((hh) => hh.rect.y > H * 0.8 && hh.rect.x > 0 && hh.rect.y < navTop);
    const inputHit = bottom.reduce((a, b) => (b.rect.x < a.rect.x ? b : a));
    inputHit.fn(); // simulate the tap

    expect(scene.core.worldChatActive).toBe(true);
    scene.core.caretOn = true;
    scene.render();
    expect(collectTexts(scene.container)).toContain('|'); // empty field + blink-on → caret alone
    scene.destroy();
  });
});

describe('AuctionScene — designated-buyer field caret', () => {
  function build(): any {
    return new AuctionScene(createLayout(W, H), new InputManager(), {
      openTextInput: openDomTextInput,
      onBack() {}, worldApi: stubWorldApi(),
    });
  }

  it('buyer field shows a blinking cursor while focused', () => {
    const scene = build();
    scene.core.buyerActive = true;
    scene.core.createBuyer = 'acc_42';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.createListing.openCreateForm(), 'acc_42|');
    scene.destroy();
  });

  it('buyer field shows a blinking cursor while focused and empty (falls back to caret, not placeholder)', () => {
    const scene = build();
    scene.core.buyerActive = true;
    scene.core.createBuyer = '';
    expectBlinkingCaret(scene.container, (on) => { scene.core.caretOn = on; }, () => scene.createListing.openCreateForm(), '|');
    scene.destroy();
  });

  it('unfocused buyer field never shows a cursor', () => {
    const scene = build();
    scene.core.buyerActive = false;
    scene.core.createBuyer = 'acc_42';
    scene.core.caretOn = true;
    scene.createListing.openCreateForm();
    expect(collectTexts(scene.container)).not.toContain('acc_42|');
    scene.destroy();
  });
});

describe('FeedbackDialog — input field caret (2026-08-08: was a plain string concat, no caretDisplay)', () => {
  function build(): any {
    return new FeedbackDialog(800, 1280, { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
  }

  it('starts unfocused: placeholder shown, no cursor', () => {
    const scene = build();
    expect(collectTexts(scene.container)).not.toContain('|');
    scene.destroy();
  });

  it('tapping the field (openInput) focuses it and shows a blinking cursor on an empty value', () => {
    const scene = build();
    scene.openInput(); // simulates the pointertap handler wired on the input box
    expect(scene.inputActive).toBe(true);
    expectBlinkingCaret(scene.container, (on: boolean) => { scene.caretOn = on; }, () => scene.refreshLabel(), '|');
    scene.destroy();
  });

  it('typed text keeps a trailing blinking cursor and switches the label to dark (not placeholder grey)', () => {
    const scene = build();
    scene.openInput();
    scene.feedbackText = 'great game, love the ink splatter!';
    expectBlinkingCaret(scene.container, (on: boolean) => { scene.caretOn = on; }, () => scene.refreshLabel(), 'great game, love the ink splatter!|');
    scene.refreshLabel();
    // PIXI's TextStyle.fill setter normalizes a numeric color to its CSS hex-string form.
    expect(scene.feedbackLabel.style.fill).toBe('#' + C.dark.toString(16).padStart(6, '0'));
    scene.destroy();
  });

  it('update(dt) drives the blink on the same 0.5s cycle as SettingsScene', () => {
    const scene = build();
    scene.openInput();
    scene.feedbackText = 'hi';
    scene.refreshLabel();
    expect(collectTexts(scene.container)).toContain('hi|');
    scene.update(0.5); // one half-period
    expect(collectTexts(scene.container)).toContain('hi');
    expect(collectTexts(scene.container)).not.toContain('hi|');
    scene.update(0.5); // back on
    expect(collectTexts(scene.container)).toContain('hi|');
    scene.destroy();
  });

  it('update(dt) is a no-op while unfocused — no caretTimer ticking, no re-render, when nothing is open', () => {
    const scene = build();
    scene.feedbackText = 'draft';
    scene.refreshLabel();
    const before = scene.feedbackLabel.text;
    scene.update(0.5);
    scene.update(0.5);
    expect(scene.feedbackLabel.text).toBe(before); // unchanged — inputActive is false
    scene.destroy();
  });

  it('unfocused field never shows a cursor regardless of blink phase', () => {
    const scene = build();
    scene.feedbackText = 'draft';
    scene.inputActive = false;
    scene.caretOn = true;
    scene.refreshLabel();
    expect(collectTexts(scene.container)).not.toContain('draft|');
    scene.destroy();
  });

  it('blurring the hidden input (simulated) drops the cursor and stops the blink', () => {
    const scene = build();
    scene.openInput();
    scene.feedbackText = 'note';
    scene.refreshLabel();
    expect(collectTexts(scene.container)).toContain('note|');

    // Mirrors the real 'blur' listener registered in openInput().
    scene.inputActive = false;
    scene.refreshLabel();
    expect(collectTexts(scene.container)).not.toContain('note|');
    expect(collectTexts(scene.container)).toContain('note');

    // Ticking update(dt) afterwards must not resurrect the cursor.
    scene.update(0.5);
    scene.update(0.5);
    expect(collectTexts(scene.container)).not.toContain('note|');
    scene.destroy();
  });

  it('input box holds at least 3 visible lines of wrapped text (2026-08-08: was a single line)', () => {
    const scene = build();
    const lineH = scene.feedbackLabel.style.lineHeight as number;
    // Before this fix feedbackLabel never set an explicit lineHeight at all (PIXI default 0,
    // meaning "derive from font metrics") — an explicit positive value is itself the regression
    // signal that the box was resized around a known line height rather than a single-line guess.
    expect(lineH).toBeGreaterThan(0);
    // statusLabel is laid out right after the input box (+ a small fixed gap), and feedbackLabel is
    // now top-anchored at the box's inner top padding — so this vertical span is a tight lower bound
    // on the box's real content height, without needing to expose inputH itself as a field.
    const span = scene.statusLabel.y - scene.feedbackLabel.y;
    expect(span).toBeGreaterThanOrEqual(lineH * 3);
    scene.destroy();
  });

  // 2026-08-08 bug: FeedbackDialog (and AppealDialog) are stage-level overlays mounted directly on
  // app.stage, outside SceneManager entirely — SceneManager.onTick only ticks its own
  // current/overlayScene, so nothing was calling FeedbackDialog.update() in production. The caret
  // blinked correctly in every test above because those tests call scene.update(dt) themselves; that
  // never proved anyone else does in the real app. This drives it through a REAL PIXI.Ticker exactly
  // the way app.ts's `app.ticker.add(() => feedbackDialog?.update(app.ticker.deltaMS/1000))` fix does,
  // over real wall-clock time — the closest a headless test gets to the actual production wiring.
  // See test/appTickerDialogWiring.test.ts for the complementary static check that app.ts itself still
  // contains that call.
  it('a real PIXI.Ticker driven exactly like app.ts (2026-08-08 fix) blinks the caret over real time', async () => {
    const scene = build();
    scene.openInput();
    expect(collectTexts(scene.container)).toContain('|'); // caret on right after openInput(), synchronously

    const ticker = new PIXI.Ticker();
    ticker.autoStart = false; // default minFPS=10 clamp stays on, same as the real app.ticker
    ticker.add(() => { scene.update(ticker.deltaMS / 1000); });
    ticker.update(performance.now()); // prime lastTime (first call's huge delta-vs-sentinel gets clamped)

    // Drive real frames every ~50ms (well under the clamp, so each tick's deltaMS reflects real
    // elapsed time) until real wall-clock time has crossed the 0.5s blink half-period.
    let elapsed = 0;
    while (elapsed < 560) {
      await new Promise((r) => setTimeout(r, 50));
      elapsed += 50;
      ticker.update(performance.now());
    }
    expect(collectTexts(scene.container)).not.toContain('|'); // must have blinked OFF from a ticker alone

    ticker.destroy();
    scene.destroy();
  });
});

// 2026-08-09 bug: the full-screen `dim` overlay (drawn behind the card to block whatever's underneath)
// never got `eventMode`/`hitArea` set on any of the four self-drawn "blocking full-screen card" dialogs
// in this family (Feedback/Appeal/Consent/Reconnect — see their near-identical class docs), so PIXI's
// hit-testing skipped straight past `dim` to whatever sat at that screen position — a tap anywhere on
// the dimmed backdrop (not just the card) passed through as if the dialog wasn't there. Reported against
// FeedbackDialog specifically: it's mounted directly on `app.stage` (app.ts) alongside whatever scene is
// still live underneath, same as AppealDialog — both are genuinely exploitable click-throughs. The bug
// itself is orientation-agnostic (nothing in any of these `build()` methods branches hit-testing by
// landscape/portrait — the `landscape` check only sizes the card); FeedbackDialog only got reported for
// portrait because that's where the Lobby's bottom nav happens to sit directly behind the card, while
// landscape had nothing clickable positioned there. ConsentDialog/ReconnectPromptDialog go through
// `manager.goto()` instead (SceneManager guarantees only one scene is ever mounted, so there's nothing
// live to click through to today) — fixed anyway for defense-in-depth/consistency with their siblings.
// Fix mirrors SceneManager's own tap-swallowing fade overlay (`showOverlay()`): `eventMode = 'static'`
// + explicit full-screen `hitArea`.
describe('Stage-level "blocking full-screen card" dialogs — dim backdrop swallows taps in both orientations (2026-08-09 click-through fix)', () => {
  // All four share the same build() shape: buildPaperBackground() added first, `dim` second.
  function findDim(container: PIXI.Container): PIXI.Graphics {
    const dim = container.children[1] as PIXI.Graphics;
    expect(dim).toBeInstanceOf(PIXI.Graphics);
    return dim;
  }

  function expectFullScreenDim(container: PIXI.Container, w: number, h: number): void {
    const dim = findDim(container);
    expect(dim.eventMode).toBe('static');
    expect(dim.hitArea).toEqual(new PIXI.Rectangle(0, 0, w, h));
  }

  const SIZES: Array<[label: string, w: number, h: number]> = [
    ['landscape (1280x800)', 1280, 800],
    ['portrait (800x1280)', 800, 1280],
  ];

  describe('FeedbackDialog', () => {
    for (const [label, w, h] of SIZES) {
      it(`${label}: dim backdrop is static and hit-tests the full screen`, () => {
        const scene = new FeedbackDialog(w, h, { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
        expectFullScreenDim(scene.container, w, h);
        scene.destroy();
      });
    }
  });

  describe('AppealDialog', () => {
    for (const [label, w, h] of SIZES) {
      it(`${label}: dim backdrop is static and hit-tests the full screen`, () => {
        const scene = new AppealDialog(w, h, 'ACCOUNT_BANNED', { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
        expectFullScreenDim(scene.container, w, h);
        scene.destroy();
      });
    }
  });

  describe('ConsentDialog', () => {
    for (const [label, w, h] of SIZES) {
      it(`${label}: dim backdrop is static and hit-tests the full screen`, () => {
        const scene = new ConsentDialog(w, h, { onAccept() {} });
        expectFullScreenDim(scene.container, w, h);
        scene.destroy();
      });
    }
  });

  describe('ReconnectPromptDialog', () => {
    for (const [label, w, h] of SIZES) {
      it(`${label}: dim backdrop is static and hit-tests the full screen`, () => {
        const scene = new ReconnectPromptDialog(w, h, { onReconnect() {}, onDecline() {} });
        expectFullScreenDim(scene.container, w, h);
        scene.destroy();
      });
    }
  });
});

// More angles on the same 2026-08-08 ticker-wiring fix, beyond "does the caret blink at all":
// the closure shape app.ts actually uses (`let feedbackDialog: FeedbackDialog | null = null`,
// reassigned by setFeedbackSink/closeFeedbackDialog, read by a ticker callback registered ONCE in
// startApp() and never removed for the app's whole lifetime) has edge cases none of the tests above
// exercise, since they all hold a single instance for the test's whole duration.
describe('app.ts ticker wiring — closure/reopen/AppealDialog edge cases (2026-08-08 fix, more angles)', () => {
  it('AppealDialog.update() (no-op today, zero args) survives being driven by the same real-Ticker shape', async () => {
    const dlg = new AppealDialog(800, 1280, 'ACCOUNT_BANNED', { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
    const ticker = new PIXI.Ticker();
    ticker.autoStart = false;
    // Mirrors app.ts's `appealDialog?.update()` — note zero args, unlike feedbackDialog's `update(dt)`.
    ticker.add(() => { dlg.update(); });
    expect(() => {
      ticker.update(performance.now());
      ticker.update(performance.now() + 20);
      ticker.update(performance.now() + 40);
    }).not.toThrow();
    ticker.destroy();
    dlg.destroy();
  });

  it('the ticker callback tolerates feedbackDialog being nulled out mid-stream (mirrors closeFeedbackDialog())', () => {
    let feedbackDialog: FeedbackDialog | null = new FeedbackDialog(800, 1280, { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
    (feedbackDialog as unknown as { openInput(): void }).openInput();

    const ticker = new PIXI.Ticker();
    ticker.autoStart = false;
    // Exact app.ts shape: the callback closes over the outer `let`, not a fixed instance.
    ticker.add(() => { feedbackDialog?.update(ticker.deltaMS / 1000); });
    ticker.update(performance.now());
    expect(collectTexts(feedbackDialog.container)).toContain('|');

    // closeFeedbackDialog() does dlg.destroy() then feedbackDialog = null — the SAME already-registered
    // ticker callback (added once in startApp(), never removed) keeps firing every frame afterward.
    feedbackDialog.destroy();
    feedbackDialog = null;
    expect(() => {
      for (let i = 0; i < 5; i++) ticker.update(performance.now() + i * 20);
    }).not.toThrow();

    ticker.destroy();
  });

  it('reopening (a fresh instance replacing the outer `let`) keeps blinking — the callback reads the variable, not a captured instance', async () => {
    let feedbackDialog: FeedbackDialog | null = null;
    const ticker = new PIXI.Ticker();
    ticker.autoStart = false;
    ticker.add(() => { feedbackDialog?.update(ticker.deltaMS / 1000); });
    ticker.update(performance.now()); // ticking with nothing open yet must be a harmless no-op

    // setFeedbackSink()'s handler: construct a new dialog and assign it to the same outer variable.
    feedbackDialog = new FeedbackDialog(800, 1280, { openTextInput: openDomTextInput, onSubmit: async () => {}, onClose() {} });
    (feedbackDialog as unknown as { openInput(): void }).openInput();
    expect(collectTexts(feedbackDialog.container)).toContain('|');

    let elapsed = 0;
    while (elapsed < 560) {
      await new Promise((r) => setTimeout(r, 50));
      elapsed += 50;
      ticker.update(performance.now());
    }
    expect(collectTexts(feedbackDialog.container)).not.toContain('|'); // the NEW instance blinks too

    feedbackDialog.destroy();
    ticker.destroy();
  });
});

describe('LoginScene — email/password field caret (already-correct baseline)', () => {
  function build(): any {
    return new LoginScene(createLayout(W, H), new InputManager(), {
      openTextInput: openDomTextInput,
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
