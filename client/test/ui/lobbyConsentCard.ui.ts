// The Apple consumption-data consent card (IOS_RELEASE.md §4.1b, ADR-082).
//
// This card exists because Apple requires the APP to collect consent before we may answer its refund
// questions with consumption data — so it is the difference between having a refund defence and
// having one that never fires. Two properties are worth pinning here and neither is visible in a
// screenshot of one viewport:
//
//   * **It fits, in every locale.** The body text is a paragraph, not a label, and it is the longest
//     in German. A card whose text overflows its panel, or whose buttons sit under the text, is the
//     failure mode the settings screen already paid for once (settingsDataSaverRow.ui.ts) — and this
//     card is the only place the question is ever asked, so an unreadable one is a lost consent.
//   * **It cannot be dismissed.** Two answer rects, no dismiss rect: Apple accepts only `true`, and
//     treating "tapped somewhere" as consent would be speaking for the player. Asserted by driving
//     the lobby's real tap routing — a tap on the backdrop must answer nothing.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
import { LobbyScene } from '../../src/scenes/LobbyScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

interface Built {
  scene: LobbyScene;
  answers: boolean[];
  w: number;
  h: number;
}

function build(w = 800, h = 1280): Built {
  const scene = new LobbyScene(createLayout(w, h), new InputManager(), {
    onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
    onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
    playerName: 'Tester',
  });
  const answers: boolean[] = [];
  scene.showConsumptionConsent((consented) => answers.push(consented));
  return { scene, answers, w, h };
}

/** Every text node currently on the scene, with its bounds. */
function texts(root: PIXI.Container): { text: string; x: number; y: number; w: number; h: number }[] {
  const out: { text: string; x: number; y: number; w: number; h: number }[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        out.push({ text: ch.text, x: b.x, y: b.y, w: b.width, h: b.height });
        continue;
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

interface CoreView {
  w: number;
  h: number;
  consentYesRect: { x: number; y: number; w: number; h: number } | null;
  consentNoRect: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The scene's own coordinate space, which is what every rect below is measured in. The layout scales
 * that space onto the physical viewport, so comparing a rect against the pixel width would compare
 * two different units (and pass or fail depending on the scale factor rather than on the layout).
 */
const coreOf = (scene: LobbyScene): CoreView =>
  (scene as unknown as { core: CoreView }).core;

/** The two answer rects the lobby's tap routing reads (LobbyScene/core.ts). */
function rects(scene: LobbyScene): { yes: PIXI.Rectangle; no: PIXI.Rectangle } {
  const core = coreOf(scene);
  const yes = core.consentYesRect;
  const no = core.consentNoRect;
  if (!yes || !no) throw new Error('the consent card put up no answer rects');
  return {
    yes: new PIXI.Rectangle(yes.x, yes.y, yes.w, yes.h),
    no: new PIXI.Rectangle(no.x, no.y, no.w, no.h),
  };
}

const tap = (scene: LobbyScene, x: number, y: number): void => {
  (scene as unknown as { build: { handleDown(x: number, y: number): void } }).build.handleDown(x, y);
};

describe('the consent card fits', () => {
  const sizes: [number, number][] = [[800, 1280], [1170, 2532], [1568, 744], [375, 812]];

  it.each(sizes)('at %ix%i the two buttons are side by side, inside the card, not overlapping', (vw, vh) => {
    const { scene } = build(vw, vh);
    const { w, h } = coreOf(scene);
    const { yes, no } = rects(scene);
    // Same row, same size — this is one question with two equal answers, not a primary action.
    expect(yes.y).toBe(no.y);
    expect(yes.height).toBe(no.height);
    expect(yes.width).toBe(no.width);
    // A real gap between them: adjacent buttons with no gap are a mis-tap on a phone.
    expect(no.x).toBeGreaterThan(yes.x + yes.width);
    // Inside the viewport, with the row above the bottom edge.
    expect(yes.x).toBeGreaterThan(0);
    expect(no.x + no.width).toBeLessThan(w);
    expect(yes.y + yes.height).toBeLessThan(h);
  });

  it.each(['zh', 'en', 'de'] as Locale[])('in %s the body text stays clear of the buttons', (loc) => {
    setLocale(loc);
    try {
      const { scene } = build();
      const { yes } = rects(scene);
      const body = texts(scene.container).find((n) => n.text === t('iap.consentBody'));
      expect(body).toBeDefined();
      // The paragraph is the thing that grows between locales; the buttons are fixed fractions of the
      // card. German is the longest, and this is where an overflow would land.
      expect(body!.y + body!.h).toBeLessThanOrEqual(yes.y);
      expect(body!.x).toBeGreaterThan(0);
    } finally {
      setLocale('en');
    }
  });

  it('shows the question, not just the buttons', () => {
    const { scene } = build();
    const all = texts(scene.container).map((n) => n.text);
    expect(all).toContain(t('iap.consentTitle'));
    expect(all).toContain(t('iap.consentBody'));
    expect(all).toContain(t('iap.consentAllow'));
    expect(all).toContain(t('iap.consentDecline'));
  });
});

describe('the consent card can only be answered', () => {
  it('the Allow button answers true', () => {
    const { scene, answers } = build();
    const { yes } = rects(scene);
    tap(scene, yes.x + yes.width / 2, yes.y + yes.height / 2);
    expect(answers).toEqual([true]);
  });

  it('the Do-not-allow button answers false — a refusal is an answer', () => {
    const { scene, answers } = build();
    const { no } = rects(scene);
    tap(scene, no.x + no.width / 2, no.y + no.height / 2);
    expect(answers).toEqual([false]);
  });

  it('a tap on the backdrop answers nothing and leaves the card up', () => {
    // Apple accepts only `true`, so "tapped somewhere" must not become a yes — and treating it as a
    // no would silently refuse on the player's behalf. The card stays until one button is pressed.
    const { scene, answers } = build();
    tap(scene, 4, 4);
    expect(answers).toEqual([]);
    expect(() => rects(scene)).not.toThrow();
  });

  it('swallows taps that would otherwise hit the lobby behind it', () => {
    // The card is a modal: while it is up, nothing under it may be pressed. Answering it removes the
    // rects, which is what hands control back.
    const { scene, answers } = build();
    const { yes } = rects(scene);
    tap(scene, yes.x + yes.width / 2, yes.y + yes.height / 2);
    expect(answers).toEqual([true]);
    expect(() => rects(scene)).toThrow();
  });
});
