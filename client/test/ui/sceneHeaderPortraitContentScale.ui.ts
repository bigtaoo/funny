// Regression coverage for the portrait top-bar "content looks too small" fix (2026-08-11, user
// screenshot of CardScene/"卡背包"): sceneHeaderHeight(h) = h*0.12 already gives the bar itself a
// generous ~12% of real screen height on tall portrait phones (PortraitLayout stretches design
// height well past 1920 on notched/tall aspects so there's no letterbox) — but the back-button and
// title font size used to be pinned to the flat FS.headline token, which is sized off the design
// *width* (portrait) rather than the bar's own height, so it never grew with a taller bar. Net
// effect: a real ~98px-tall bar on a 375x812 screen rendering ~15px text, reading as "not enough
// height" when the bar actually had plenty going unused.
//
// Fix: `backSize(headerH)` (used for both the back button and the default title size) now scales
// with the bar's own headerH, floored at the original FS.headline so compact/landscape bars are
// unaffected — only bars taller than the landscape default (headerH design ≈130) actually grow.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// getCachedDisplay() has no renderer wired in this env, so it transparently falls back to a live
// draw (see uiCache.ts) — the back-button chip is a real, walkable PIXI.Container tree here, not a
// baked Sprite, which is what lets this test reach into it.
// Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawSceneHeader, drawFloatingBackButton } from '../../src/ui/widgets/SceneHeader';
import { FS } from '../../src/render/fontScale';
import { initI18n } from '../../src/i18n';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Landscape's default design height (LandscapeLayout's fixed axis) — headerH design ≈130, below
 *  the floor, so this is the "should render unchanged" baseline. */
const LANDSCAPE_H = 1080;
/** A tall-portrait design height matching a real 375×812 phone (PortraitLayout.designHeight,
 *  computed in the investigation for this fix: round(1080 * 812/375) = 2339). */
const TALL_PORTRAIT_H = 2339;

/** Depth-first search for the first PIXI.Text anywhere under `root` (chrome/back-chip text is
 *  nested a couple of containers deep, not a direct child). */
function findText(root: PIXI.Container): PIXI.Text | null {
  for (const child of root.children) {
    if (child instanceof PIXI.Text) return child;
    if (child instanceof PIXI.Container) {
      const found = findText(child);
      if (found) return found;
    }
  }
  return null;
}

function fontSizeOf(root: PIXI.Container): number {
  const text = findText(root);
  if (!text) throw new Error('no text node found under root');
  return (text.style as PIXI.TextStyle).fontSize as number;
}

describe('SceneHeader portrait content scaling (2026-08-11 fix)', () => {
  it('compact/landscape bars keep the original flat FS.headline size for the title (no regression)', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, 1920, LANDSCAPE_H, 'Auction');
    // The bar's own back-chip lives in the first child (chrome); the title is the plain second child.
    const title = c.children[1] as PIXI.Text;
    expect(title.style.fontSize).toBe(FS.headline);
  });

  it('a tall portrait bar renders its title text visibly larger than the landscape default', () => {
    const c = new PIXI.Container();
    const hdr = drawSceneHeader(c, 1080, TALL_PORTRAIT_H, 'Roster');
    const title = c.children[1] as PIXI.Text;
    expect(title.style.fontSize).toBeGreaterThan(FS.headline);
    // Matches the ratio computed against the bar's own actual headerH, not a hardcoded pixel value,
    // so this tracks HEADER_CONTENT_RATIO if it's ever retuned instead of asserting a magic number.
    expect(title.style.fontSize).toBe(Math.round(hdr.headerH * 0.30));
  });

  it('an explicit titleSize override still wins over the scaled default', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, 1080, TALL_PORTRAIT_H, 'Roster', { titleSize: 24 });
    const title = c.children[1] as PIXI.Text;
    expect(title.style.fontSize).toBe(24);
  });

  it('the back-button label itself also grows on a tall portrait bar, not just the title', () => {
    const compact = new PIXI.Container();
    drawSceneHeader(compact, 1920, LANDSCAPE_H, 'Auction');
    const tall = new PIXI.Container();
    drawSceneHeader(tall, 1080, TALL_PORTRAIT_H, 'Roster');
    expect(fontSizeOf(tall)).toBeGreaterThan(fontSizeOf(compact));
  });

  // Same-day follow-up (2026-08-11): the back-button font growing above made the tall-portrait
  // chip visibly wider than the hardcoded BACK_HIT_W=160 backRect used to report — a real bug,
  // not just a hit-testing nit. WorldMapPanels/hud.ts reads backRect.w to know "where the back
  // button ends" and positions the resource-cluster's opaque background right after it; an
  // under-reported width let that background paint over the tail of the back label ("← Bac[k]"
  // in the user's screenshot). backRect.w must track the real chip, not just the tap-target floor.
  it('backRect.w on a tall portrait bar is at least as wide as the actually-rendered back chip (not the flat tap-target floor)', () => {
    const tall = new PIXI.Container();
    const tallHdr = drawSceneHeader(tall, 1080, TALL_PORTRAIT_H, 'Roster');

    // The back chip is the last child added to the chrome container (see buildChrome: bg →
    // guilloche weave → accent rule → chip).
    const chrome = tall.children[0] as PIXI.Container;
    const chip = chrome.children[chrome.children.length - 1] as PIXI.Container;
    expect(chip).toBeTruthy();
    // width getter includes children's rendered bounds — the pill background sized to fit the label.
    expect(tallHdr.backRect.w).toBeGreaterThanOrEqual(chip.width);
  });

  // The headless text-metrics stub (test/harness/pixiHeadless.ts) measures purely by character
  // count, not fontSize, so a moderately tall bar's chip growth can coincidentally still land
  // right at the flat 160 floor in this env even though real font rendering would clearly exceed
  // it (padding alone — independent of the stub — already scales with headerH). Use an extreme
  // height so the chip's padding-driven growth unambiguously clears the floor even under the
  // crude stub, proving backRect.w tracks the chip rather than staying pinned at 160.
  it('backRect.w grows past the flat 160 floor on an extremely tall bar, tracking the real chip', () => {
    const EXTREME_PORTRAIT_H = 6000;
    const c = new PIXI.Container();
    const hdr = drawSceneHeader(c, 1080, EXTREME_PORTRAIT_H, 'Roster');
    const chrome = c.children[0] as PIXI.Container;
    const chip = chrome.children[chrome.children.length - 1] as PIXI.Container;
    expect(hdr.backRect.w).toBeGreaterThan(160);
    expect(hdr.backRect.w).toBeGreaterThanOrEqual(chip.width);
  });

  it("the floating back button (full-bleed scenes) matches drawSceneHeader's back-button size at the same screen height", () => {
    // drawFloatingBackButton has no real bar, so it must derive the same notional headerH
    // drawSceneHeader would have used, or its back chip would size differently from every other
    // scene's back button on the same device — reintroducing the per-scene inconsistency this
    // whole module exists to prevent.
    const barContainer = new PIXI.Container();
    drawSceneHeader(barContainer, 1080, TALL_PORTRAIT_H, null);

    const floatContainer = new PIXI.Container();
    drawFloatingBackButton(floatContainer, TALL_PORTRAIT_H);

    expect(fontSizeOf(floatContainer)).toBe(fontSizeOf(barContainer));
  });
});
