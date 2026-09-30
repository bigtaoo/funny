// `fitOrWrap` (src/render/sketchUi.ts) replaced `if (w > maxW) t.scale.set(maxW / w)` on short fixed
// labels, which drew German under the legibility floor (design/game/UI_DESIGN_LOG_2026-09.md §70).
// The contract: a label that fits is untouched; one that fits by shrinking no further than the floor
// allows comes out exactly as the old code drew it; anything wider is held at the floor and wrapped.
// Plus the one shared widget it changed the layout of: a wrapped HubTabs rail / bottom-bar cell.
//
// Runs under the headless PIXI adapter (7px per character at any size). Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { txt, fitOrWrap } from '../../src/render/sketchUi';
import { setFontScale, resetFontScaleForTest, currentFontFloor } from '../../src/render/fontScale';
import { drawSidebarTabs, drawBottomNavTabs } from '../../src/ui/widgets/HubTabs';

afterEach(() => resetFontScaleForTest());

/** A 360-wide portrait phone: 1080 design px at 1/3, floor 20. */
const phone = (): void => { setFontScale(1 / 3); expect(currentFontFloor()).toBe(20); };

describe('fitOrWrap', () => {
  it('leaves a label that fits alone', () => {
    phone();
    const t = txt('Short', 24, 0, true);
    expect(fitOrWrap(t, 200)).toBe(false);
    expect(t.scale.x).toBe(1);
    expect(t.style.wordWrap).toBe(false);
  });

  it('shrinks exactly as the old code did while that stays at or above the floor', () => {
    phone();
    const t = txt('x'.repeat(20), 24, 0, true); // 140 wide
    const maxW = 125; // 0.89 >= 20/24
    expect(fitOrWrap(t, maxW)).toBe(false);
    expect(t.scale.x).toBeCloseTo(maxW / 140, 6);
    expect(t.width).toBeCloseTo(maxW, 3);
  });

  it('stops at the floor and wraps what is left, inside maxW', () => {
    phone();
    const t = txt('Wöchentliche Truhe', 24, 0, true); // 126 wide
    const maxW = 90; // would need 0.71 < 20/24
    expect(fitOrWrap(t, maxW)).toBe(true);
    expect(24 * t.scale.x).toBeCloseTo(20, 6);
    expect(t.width).toBeLessThanOrEqual(maxW + 0.01);
    const oneLine = txt('W', 24, 0, true);
    expect(t.height).toBeGreaterThan(oneLine.height * t.scale.y * 1.5);
  });

  it('never wraps a label already at the floor size into a smaller one', () => {
    phone();
    const t = txt('Schutzstein x0 (Material bei Fehlschlag behalten)', 20, 0);
    expect(fitOrWrap(t, 150)).toBe(true);
    expect(t.scale.x).toBe(1);
  });
});

function labelsOf(c: PIXI.Container): PIXI.Text[] {
  return c.children.filter((n): n is PIXI.Text => n instanceof PIXI.Text);
}

describe('HubTabs cells whose label wraps', () => {
  const tabs = (label: string) => [{ label, active: false, icon: 'check' as const }, { label: 'Ok', active: true, icon: 'check' as const }];

  it('rail: a label too long for the cell sits on two lines under a smaller icon, inside the cell', () => {
    phone();
    const c = new PIXI.Container();
    // 1080-tall landscape design space at a rail 150 wide: cell 97 tall, label budget 129 px at 24.
    const h = 1080, sidebarW = 150;
    const { hits } = drawSidebarTabs(c, sidebarW, 0, h, tabs('Wöchentliche Truhe Wöchentliche'), () => {});
    const cell = hits[0]!.rect;
    const lbl = labelsOf(c).find((l) => l.text.startsWith('Wöchentliche'))!;
    const b = lbl.getBounds();
    expect(lbl.style.wordWrap, 'wrapped').toBe(true);
    expect(lbl.style.fontSize as number * lbl.scale.x).toBeGreaterThanOrEqual(20);
    expect(b.left).toBeGreaterThanOrEqual(cell.x);
    expect(b.right).toBeLessThanOrEqual(cell.x + cell.w);
    expect(b.bottom).toBeLessThanOrEqual(cell.y + cell.h + 0.5);
    // The icon (the Graphics/Container drawn right before the label) ends above the label.
    const idx = c.children.indexOf(lbl);
    const icon = c.children[idx - 1] as PIXI.Container;
    expect(icon.getBounds().bottom).toBeLessThanOrEqual(b.top + 0.5);
  });

  it('bottom bar: same rule', () => {
    phone();
    const c = new PIXI.Container();
    // Bottom-bar labels are 42: the floor allows 0.48, so it takes ~4x the cell's label budget to wrap.
    const tabs4 = [...tabs('Wöchentliche Truhe '.repeat(4).trim()), ...tabs('B')];
    const barH = 180;
    const { hits } = drawBottomNavTabs(c, 1080, 1700, barH, tabs4, () => {});
    const cell = hits[0]!.rect;
    const lbl = labelsOf(c).find((l) => l.text.startsWith('Wöchentliche'))!;
    const b = lbl.getBounds();
    expect(lbl.style.fontSize as number * lbl.scale.x).toBeGreaterThanOrEqual(20);
    expect(lbl.style.wordWrap, 'wrapped').toBe(true);
    expect(b.right).toBeLessThanOrEqual(cell.x + cell.w);
    expect(b.bottom).toBeLessThanOrEqual(cell.y + cell.h + 0.5);
    const idx = c.children.indexOf(lbl);
    expect((c.children[idx - 1] as PIXI.Container).getBounds().bottom).toBeLessThanOrEqual(b.top + 0.5);
  });
});
