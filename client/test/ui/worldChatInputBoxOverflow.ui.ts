// Regression test: two portrait-only overflow bugs reported live in the World channel tab
// (screenshot: 地方就爱上了科技发达刷屏… spilling out from under the input box, and the send
// button's "发言 · 50 金币" cost-suffix label spilling past the button's own border).
//
// Root cause 1 (input text): drawWorldTab() drew the composed line as a plain unmasked
// PIXI.Text anchored at the box's left edge — a line long enough to exceed the box's width
// (narrow in portrait, since sendBtnW/inputW split `w`, the *device* width) just kept drawing
// past the box, over the send button. Fix: mask the text to the box's rect and, once the line
// overflows, anchor from the right so the caret at the end (what the player is actively typing)
// stays visible — same scroll behaviour a native text input gives you.
//
// Root cause 2 (send button label): addButton() sized the label purely from the button's
// *height* (`h * 0.36`), never checked it against the button's *width* — a label with a cost
// suffix ("· 50 coins") on a portrait-narrow button (`sendBtnW = w * 0.24`) drew wider than the
// button itself. Fix: addButton() now shrinks the font one step at a time until the label fits
// (floor 10px) whenever the unshrunk size would overflow.
//
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { snapFont } from '../../src/render/fontScale';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { addButton } from '../../src/scenes/FriendsScene/chrome';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('zh', memStore, ['zh', 'en', 'de']);

// Narrow portrait device (the shape the report was taken on) — landscape's sidebar-rail branch
// isn't in play here, so `w` is the full device width both the input box and the send button
// split, exactly what makes the send button narrow enough to overflow.
const [W, H] = [400, 900];
// Matches test/ui/scenes.ui.ts's own LANDSCAPE fixture — the report was portrait-only, this is
// the "make sure the fix doesn't disturb the orientation that was already fine" side of the bug.
const [LW, LH] = [1280, 800];

/** Every PIXI.Text currently in the display tree, recursing sub-containers. */
function collectTextNodes(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function build(w = W, h = H): any {
  const { openTextInput } = createFakeTextInput();
  return new FriendsScene(createLayout(w, h), new InputManager(), {
    onBack() {}, onOpenRoom() {}, openTextInput,
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
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
    getCoins: () => 100,
  });
}

function enterWorldTab(scene: any): void {
  scene.core.tab = 'world';
  scene.core.slgLoaded = true;
  scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false };
  scene.core.worldLoaded = true;
  scene.core.worldMessages = [];
  scene.render();
}

describe('FriendsScene world-chat tab — input box overflow fix', () => {
  it('a long composed line is masked to the input box and right-anchored (caret stays visible) instead of spilling past it', () => {
    const scene = build();
    enterWorldTab(scene);
    scene.core.worldChatActive = true;
    scene.core.caretOn = true;
    // Portrait's design width is a fixed 1080 (PortraitLayout — independent of the physical
    // device), so the input box itself is generously wide in design space; the field's own
    // maxLength is 200, and a player filling most of that (the field wraps to a single
    // hand-typed line, no wordWrap) is exactly the real case that overflowed in the report.
    scene.core.worldChatInput = '地方就爱上了科技发达刷屏'.repeat(15); // 180 chars, under the 200 cap
    scene.render();

    const nodes = collectTextNodes(scene.container);
    const inputTxt = nodes.find((n) => n.text.startsWith(scene.core.worldChatInput));
    expect(inputTxt).toBeTruthy();
    // Clipped to the box — this is what stops it from ever painting over the send button
    // regardless of how long the line gets.
    expect(inputTxt!.mask).toBeInstanceOf(PIXI.Graphics);
    // Overflowing text scrolls to show its tail (the caret), like a native input — anchored from
    // the right edge, not the left.
    expect(inputTxt!.anchor.x).toBe(1);

    scene.destroy();
  });

  it('a short composed line stays left-anchored (no overflow to correct for)', () => {
    const scene = build();
    enterWorldTab(scene);
    scene.core.worldChatActive = true;
    scene.core.caretOn = true;
    scene.core.worldChatInput = 'hi';
    scene.render();

    const nodes = collectTextNodes(scene.container);
    const inputTxt = nodes.find((n) => n.text.startsWith('hi'));
    expect(inputTxt).toBeTruthy();
    expect(inputTxt!.anchor.x).toBe(0);

    scene.destroy();
  });

  it('the real send-button label ("发言 · 50 金币") renders through the shrink-to-fit path without throwing', () => {
    const scene = build();
    enterWorldTab(scene);
    scene.render();

    // Note: the headless canvas stub's measureText() (test/harness/pixiHeadless.ts) returns a
    // width proportional to character count only, NOT to the requested font size — so it can't
    // reproduce the actual overflow (which only shows up once a real canvas measures a *large*
    // font, since portrait's send button is width-capped at a fixed design value while its
    // height — and so its default font size — grows unbounded on tall-aspect screens). This is
    // the "not a pixel-perfect visual regression layer" gap client-testing.md calls out; the
    // shrink *mechanism* itself is covered against a deliberately narrow width below.
    const sendLabel = t('social.world.sendBtn');
    const nodes = collectTextNodes(scene.container);
    const btnTxt = nodes.find((n) => n.text === sendLabel);
    expect(btnTxt).toBeTruthy();
    expect(btnTxt!.style.fontSize).toBeGreaterThan(0);

    scene.destroy();
  });
});

describe('FriendsScene world-chat tab — landscape is unaffected by the portrait fix', () => {
  // Landscape's content column is generously wide (design width is at least the classic 1920,
  // and never shrinks the way portrait's device-width-driven sendBtnW/inputW split does) — a
  // normal-length message and the real send-button label both already fit comfortably. These
  // pin that the mask/anchor-flip and shrink-to-fit logic added for portrait are true no-ops
  // here, not just "probably fine because landscape wasn't in the bug report".
  it('a normal-length composed line stays left-anchored, unshifted from where it drew before the fix', () => {
    const scene = build(LW, LH);
    enterWorldTab(scene);
    scene.core.worldChatActive = true;
    scene.core.caretOn = true;
    scene.core.worldChatInput = 'hello world, this is a normal chat message';
    scene.render();

    const nodes = collectTextNodes(scene.container);
    const inputTxt = nodes.find((n) => n.text.startsWith(scene.core.worldChatInput));
    expect(inputTxt).toBeTruthy();
    expect(inputTxt!.anchor.x).toBe(0);
    // Left edge sits at the box's left padding, same spot a plain left-anchored, unmasked text
    // would have drawn at pre-fix — the added mask doesn't shift anything when it isn't cropping.
    const core = scene.core;
    const px = core.cX;
    const sendBtnW = Math.round(core.w * 0.24);
    const inputW = core.cW - sendBtnW - Math.round(core.w * 0.02);
    const padX = Math.round(inputW * 0.04);
    expect(inputTxt!.x).toBe(px + padX);

    scene.destroy();
  });

  it('an implausibly long line still overflows gracefully (mask + right-anchor) rather than being a portrait-only code path', () => {
    const scene = build(LW, LH);
    enterWorldTab(scene);
    scene.core.worldChatActive = true;
    scene.core.caretOn = true;
    // Landscape's own input box is wider than portrait's, so it takes a longer line to
    // genuinely exceed it — same 180-char line the portrait test uses comfortably clears it.
    scene.core.worldChatInput = '地方就爱上了科技发达刷屏'.repeat(15);
    scene.render();

    const nodes = collectTextNodes(scene.container);
    const inputTxt = nodes.find((n) => n.text.startsWith(scene.core.worldChatInput));
    expect(inputTxt).toBeTruthy();
    expect(inputTxt!.mask).toBeInstanceOf(PIXI.Graphics);
    expect(inputTxt!.anchor.x).toBe(1);

    scene.destroy();
  });

  it('the real send-button label keeps its default (unshrunk) font size — landscape\'s button is wide enough that the fit loop never engages', () => {
    const scene = build(LW, LH);
    enterWorldTab(scene);
    scene.render();

    const core = scene.core;
    const sendBtnW = Math.round(core.w * 0.24);
    const boxH = Math.round(Math.round(core.h * 0.1) * 0.75);
    const defaultSize = snapFont(Math.round(boxH * 0.36));

    const sendLabel = t('social.world.sendBtn');
    const nodes = collectTextNodes(scene.container);
    const btnTxt = nodes.find((n) => n.text === sendLabel);
    expect(btnTxt).toBeTruthy();
    expect(btnTxt!.style.fontSize).toBe(defaultSize);
    // Sanity: the button really is wide enough for this not to be a coincidence — otherwise this
    // assertion would pass even if the shrink loop mis-fired at a smaller-but-still-valid size.
    expect(sendBtnW).toBeGreaterThan(300);

    scene.destroy();
  });
});

describe('addButton() — shrink-to-fit font sizing (chrome.ts)', () => {
  function fakeCore(): any {
    return { container: new PIXI.Container(), hits: [] };
  }

  it('a label wider than the button shrinks down to the 10px floor instead of overflowing', () => {
    const core = fakeCore();
    // Narrow enough that even the headless stub's crude character-count width estimate
    // (test/harness/pixiHeadless.ts) exceeds the button — enough to exercise the shrink loop's
    // control flow (terminates, lands on the floor) even though it can't reproduce the real
    // font-size-driven overflow end to end (see the scene-level test above).
    addButton(core, '发言 · 50 金币', 0, 0, 50, 60, 0x2c2c2a, 0xcc9900, () => {});
    const label = core.container.children.find((c: PIXI.DisplayObject) => c instanceof PIXI.Text) as PIXI.Text;
    expect(label).toBeTruthy();
    expect(label.style.fontSize).toBe(10);
  });

  it('a short label on a generous button keeps the caller-requested (or default) size — the shrink loop is a no-op when nothing overflows', () => {
    const core = fakeCore();
    addButton(core, 'OK', 0, 0, 300, 60, 0x2c2c2a, 0xcc9900, () => {});
    const label = core.container.children.find((c: PIXI.DisplayObject) => c instanceof PIXI.Text) as PIXI.Text;
    expect(label).toBeTruthy();
    // Default sizing is `snapFont(Math.round(h * 0.36))` = snapFont(22) — well above the 10px floor.
    expect(label.style.fontSize).toBeGreaterThan(10);
  });

  it('an explicit fontSize is still respected when it already fits', () => {
    const core = fakeCore();
    addButton(core, 'OK', 0, 0, 300, 60, 0x2c2c2a, 0xcc9900, () => {}, 0xffffff, 18);
    const label = core.container.children.find((c: PIXI.DisplayObject) => c instanceof PIXI.Text) as PIXI.Text;
    expect(label.style.fontSize).toBe(18);
  });

  it('the real send button at landscape geometry (461×81, the shape a 1280×800 device computes) does not shrink', () => {
    const core = fakeCore();
    addButton(core, '发言 · 50 金币', 0, 0, 461, 81, 0x2c2c2a, 0xcc9900, () => {});
    const label = core.container.children.find((c: PIXI.DisplayObject) => c instanceof PIXI.Text) as PIXI.Text;
    expect(label).toBeTruthy();
    expect(label.style.fontSize).toBe(snapFont(Math.round(81 * 0.36)));
  });
});
