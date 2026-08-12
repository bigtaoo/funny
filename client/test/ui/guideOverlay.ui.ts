// Regression coverage for GuideOverlay (client/src/render/GuideOverlay.ts) — the SLG opening
// guide chain's spotlight widget (ONBOARDING_DESIGN §4.2). Pure component tests: no scene, no
// WorldMapContext/CitySceneCore, just the widget's own public surface.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { GuideOverlay } from '../../src/render/GuideOverlay';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const VIEWPORT = { w: 800, h: 1280 };
const RECT = { x: 100, y: 200, w: 120, h: 90 };

describe('GuideOverlay', () => {
  it('root starts empty with no active action until something is shown', () => {
    const guide = new GuideOverlay();
    expect(guide.root).toBeInstanceOf(PIXI.Container);
    expect(guide.currentAction()).toBeNull();
  });

  it('showAt() exposes the skip glyph as the current action, positioned near the target rect', () => {
    const guide = new GuideOverlay();
    const onSkip = vi.fn();
    guide.showAt(RECT, 'tap your city', VIEWPORT, { onSkip });

    const action = guide.currentAction();
    expect(action).not.toBeNull();
    // The skip glyph sits inside the bubble, which is placed directly above/below RECT — well
    // within a generous neighborhood of it, not off in some unrelated corner of the viewport.
    expect(action!.rect.y).toBeGreaterThan(RECT.y - 300);
    expect(action!.rect.y).toBeLessThan(RECT.y + RECT.h + 300);

    action!.fn();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('showAt() without onSkip shows no action (no skip glyph to tap)', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'no skip here', VIEWPORT);
    expect(guide.currentAction()).toBeNull();
  });

  it('re-calling showAt() with the SAME text repositions in place without rebuilding the bubble container', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'same text', VIEWPORT, { onSkip: () => {} });
    const bubbleAfterFirst = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    const movedRect = { ...RECT, x: RECT.x + 50, y: RECT.y + 50 };
    guide.showAt(movedRect, 'same text', VIEWPORT, { onSkip: () => {} });
    const bubbleAfterSecond = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    // Idempotent per the class's own doc comment: same activeKey → same bubble instance, just
    // repositioned — not torn down and rebuilt on every call (which a per-render call site like
    // CityScene.render() or WorldMapRendererLifecycle.update() would otherwise do every frame).
    expect(bubbleAfterSecond).toBe(bubbleAfterFirst);
    // But the tappable action rect DID move to track the new target.
    const action = guide.currentAction()!;
    expect(action.rect.y).not.toBe(RECT.y + 4); // sanity: it actually recomputed, not stale
  });

  it('showAt() with DIFFERENT text rebuilds the bubble (new copy replaces the old one)', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'first message', VIEWPORT, { onSkip: () => {} });
    const bubbleAfterFirst = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    guide.showAt(RECT, 'a completely different message', VIEWPORT, { onSkip: () => {} });
    const bubbleAfterSecond = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    expect(bubbleAfterSecond).not.toBe(bubbleAfterFirst);
  });

  it('places the bubble ABOVE the target when there is more room above than below', () => {
    const guide = new GuideOverlay();
    // Target sits low in a tall viewport — plenty of room above, very little below.
    const lowRect = { x: 100, y: 1150, w: 120, h: 90 };
    guide.showAt(lowRect, 'placed above', VIEWPORT, { onSkip: () => {} });
    const bubble = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring) as PIXI.Container;
    expect(bubble.y).toBeLessThan(lowRect.y);
  });

  it('places the bubble BELOW the target when there is more room below than above', () => {
    const guide = new GuideOverlay();
    // Target sits high in the viewport — plenty of room below, very little above.
    const highRect = { x: 100, y: 10, w: 120, h: 90 };
    guide.showAt(highRect, 'placed below', VIEWPORT, { onSkip: () => {} });
    const bubble = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring) as PIXI.Container;
    expect(bubble.y).toBeGreaterThan(highRect.y + highRect.h);
  });

  it('clamps the bubble horizontally within the viewport even when the target sits at the very edge', () => {
    const guide = new GuideOverlay();
    const edgeRect = { x: VIEWPORT.w - 10, y: 200, w: 90, h: 90 }; // mostly off-screen to the right
    guide.showAt(edgeRect, 'clamped', VIEWPORT, { onSkip: () => {} });
    const bubble = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring) as PIXI.Container;
    const bubbleWidth = (bubble.getChildAt(0) as PIXI.Graphics).width;
    expect(bubble.x).toBeGreaterThanOrEqual(0);
    expect(bubble.x + bubbleWidth).toBeLessThanOrEqual(VIEWPORT.w);
  });

  it('showCard() exposes the button as the current action, bottom-anchored, with no ring', () => {
    const guide = new GuideOverlay();
    const onBtn = vi.fn();
    guide.showCard('occupy nearby land', 'Got it', onBtn, VIEWPORT);

    expect((guide as unknown as { ring: PIXI.Graphics }).ring.visible).toBe(false);
    const action = guide.currentAction();
    expect(action).not.toBeNull();
    action!.fn();
    expect(onBtn).toHaveBeenCalledOnce();
  });

  it('re-calling showCard() with the SAME text is a total no-op (does not even reposition)', () => {
    const guide = new GuideOverlay();
    const onBtn = vi.fn();
    guide.showCard('same card', 'Got it', onBtn, VIEWPORT);
    const bubbleAfterFirst = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    guide.showCard('same card', 'Got it', vi.fn(), VIEWPORT); // different onBtn instance, same text
    const bubbleAfterSecond = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);

    expect(bubbleAfterSecond).toBe(bubbleAfterFirst);
    // The ORIGINAL onBtn is still the one wired — proves the second call was a true no-op, not
    // just "same visual, callback silently swapped underneath".
    guide.currentAction()!.fn();
    expect(onBtn).toHaveBeenCalledOnce();
  });

  it('showAt() → showCard() switches cleanly: ring hides, action becomes the card button', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'ring first', VIEWPORT, { onSkip: () => {} });
    expect((guide as unknown as { ring: PIXI.Graphics }).ring.visible).toBe(true);

    const onBtn = vi.fn();
    guide.showCard('then a card', 'Got it', onBtn, VIEWPORT);
    expect((guide as unknown as { ring: PIXI.Graphics }).ring.visible).toBe(false);
    guide.currentAction()!.fn();
    expect(onBtn).toHaveBeenCalledOnce();
  });

  it('hide() clears the action and bubble; a subsequent tap on the old rect does nothing', () => {
    const guide = new GuideOverlay();
    const onSkip = vi.fn();
    guide.showAt(RECT, 'about to hide', VIEWPORT, { onSkip });
    guide.hide();

    expect(guide.currentAction()).toBeNull();
    expect((guide as unknown as { ring: PIXI.Graphics }).ring.visible).toBe(false);
    // The bubble container itself was torn down and destroyed, not just hidden — no dangling
    // children left parented under root (only the (invisible) ring remains).
    expect(guide.root.children.length).toBe(1);
  });

  it('update(dt) advances the ring animation without rebuilding the bubble', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'pulsing', VIEWPORT, { onSkip: () => {} });
    const bubbleBefore = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);
    guide.update(0.5);
    guide.update(0.5);
    const bubbleAfter = guide.root.children.find((c) => c !== (guide as unknown as { ring: PIXI.Graphics }).ring);
    expect(bubbleAfter).toBe(bubbleBefore);
    // The action rect is unaffected by pure animation ticks (no target/text change).
    expect(guide.currentAction()).not.toBeNull();
  });

  it('update(dt) is a safe no-op when nothing is currently showing', () => {
    const guide = new GuideOverlay();
    expect(() => guide.update(0.5)).not.toThrow();
    expect(guide.currentAction()).toBeNull();
  });

  it('destroy() tears down the root container', () => {
    const guide = new GuideOverlay();
    guide.showAt(RECT, 'going away', VIEWPORT, { onSkip: () => {} });
    guide.destroy();
    expect(guide.root.destroyed).toBe(true);
  });
});
