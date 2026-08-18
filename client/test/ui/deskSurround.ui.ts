// Regression coverage for the iPad desk surround (2026-08-18) — see
// design/product/release/store-assets-checklist.md §0.6 for the assessment behind it.
//
// Portrait's design height is floored at 1920 (a hard floor: 70 + 18×84 + 70 + 268 = exactly 1920),
// so screens squatter than 9:16 — every iPad — contain to width and leave side bands. Those bands
// are painted as the desk the notebook page lies on instead of being left as dead paper. Phones have
// no bands and must draw nothing at all.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawDeskSurround } from '../../src/layout/ScalingManager';
import { createLayout } from '../../src/layout/ScalingManager';

/** Mirrors ScalingManager.applyScaling's contain math for a given panel (no insets). */
function pageRect(screenW: number, screenH: number) {
  const layout = createLayout(screenW, screenH);
  const scale = Math.min(screenW / layout.designWidth, screenH / layout.designHeight);
  return {
    x: Math.round((screenW - layout.designWidth * scale) / 2),
    y: Math.round((screenH - layout.designHeight * scale) / 2),
    w: layout.designWidth * scale,
    h: layout.designHeight * scale,
  };
}

const IPAD_12_9 = [2048, 2732] as const;
const IPAD_MINI = [1488, 2266] as const;
const IPHONE_15_PRO_MAX = [1290, 2796] as const;
const IPHONE_8 = [750, 1334] as const;

function draw(screen: readonly [number, number]) {
  const [w, h] = screen;
  const p = pageRect(w, h);
  const g = new PIXI.Graphics();
  const drawn = drawDeskSurround(g, w, h, p.x, p.y, p.w, p.h);
  return { g, drawn, page: p, screenW: w, screenH: h };
}

describe('desk surround — only where the page cannot fill the panel', () => {
  it('draws on iPad, where the page leaves side bands', () => {
    for (const screen of [IPAD_12_9, IPAD_MINI]) {
      const { g, drawn, page } = draw(screen);
      expect(drawn).toBe(true);
      expect(g.visible).toBe(true);
      expect(page.x).toBeGreaterThanOrEqual(2);
      // Height is always fully used in portrait — the bands are horizontal-only.
      expect(page.y).toBe(0);
    }
  });

  it('draws nothing on phones, where the page fills the panel', () => {
    for (const screen of [IPHONE_15_PRO_MAX, IPHONE_8]) {
      const { g, drawn, page } = draw(screen);
      expect(page.x).toBe(0);
      expect(drawn).toBe(false);
      expect(g.visible).toBe(false);
      expect(g.geometry.graphicsData.length).toBe(0);
    }
  });

  it('covers the whole panel, so no band pixel is left unpainted', () => {
    const { g, screenW, screenH } = draw(IPAD_12_9);
    const b = g.getLocalBounds();
    expect(b.x).toBeLessThanOrEqual(0);
    expect(b.y).toBeLessThanOrEqual(0);
    expect(b.x + b.width).toBeGreaterThanOrEqual(screenW);
    expect(b.y + b.height).toBeGreaterThanOrEqual(screenH);
  });

  it('is idempotent — a redraw (resize/orientation change) does not accumulate geometry', () => {
    const [w, h] = IPAD_12_9;
    const p = pageRect(w, h);
    const g = new PIXI.Graphics();
    drawDeskSurround(g, w, h, p.x, p.y, p.w, p.h);
    const first = g.geometry.graphicsData.length;
    drawDeskSurround(g, w, h, p.x, p.y, p.w, p.h);
    expect(g.geometry.graphicsData.length).toBe(first);
  });

  it('rescaling from iPad to a phone clears the desk instead of leaving it behind', () => {
    const g = new PIXI.Graphics();
    const pad = pageRect(...IPAD_12_9);
    drawDeskSurround(g, IPAD_12_9[0], IPAD_12_9[1], pad.x, pad.y, pad.w, pad.h);
    expect(g.geometry.graphicsData.length).toBeGreaterThan(0);
    const phone = pageRect(...IPHONE_15_PRO_MAX);
    drawDeskSurround(g, IPHONE_15_PRO_MAX[0], IPHONE_15_PRO_MAX[1], phone.x, phone.y, phone.w, phone.h);
    expect(g.geometry.graphicsData.length).toBe(0);
    expect(g.visible).toBe(false);
  });
});
