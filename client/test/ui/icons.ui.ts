// Geometry smoke-check for render/icons.ts's draw functions (test/render/icons.test.ts only
// checks that DRAW[kind] resolves to a live function — it can't construct a real PIXI.Graphics
// under plain `environment: 'node'`, which throws "document is not defined" the moment
// FillStyle→Texture.WHITE reaches for a canvas). Runs under the headless PIXI adapter
// (vitest.ui.config.ts setupFiles), which stubs exactly enough canvas/document to let PIXI build
// display objects without a real renderer — see test/harness/pixiHeadless.ts.
//
// Added for the hourglassSm/Md/Lg + armorHeavy escalating-tier icons (SLG_DESIGN_LOG.md §63):
// their `pile`/`ticks` parameters are new geometry math the plain dispatch-table check can't
// exercise. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { DRAW, type DrawableIconKind } from '../../src/render/icons';

// coin/coins/coinStack/coinSack/coinChest moved to TAB_ICON_RASTER 2026-08-25 (folded in from the
// deleted coinIconAtlas.ts) — no longer drawable, so no longer in this geometry smoke check.
const ALL_KINDS: DrawableIconKind[] = [
  'book', 'globe', 'trophy', 'castle', 'pencils',
  'scrap', 'lead', 'binding',
  'atk', 'hp', 'armor', 'armorHeavy', 'spd', 'atkspd',
  'brush',
  'swords', 'replay', 'share', 'home',
  'flag', 'desk', 'cabinet', 'hammer',
  'hourglassSm', 'hourglassMd', 'hourglassLg',
  'tag', 'capsule', 'cards', 'star', 'lock', 'medal', 'zoom', 'gift',
  'close', 'check', 'play',
  'titleBronze', 'titleSilver', 'titleGold', 'titlePlatinum', 'titleDiamond',
  'titleStar', 'titleMaster', 'titleGrandmaster', 'titleKing',
  'titleChampion', 'titleTop3',
];

describe('icons DRAW dispatch table — geometry smoke check', () => {
  it('draws without throwing for every IconKind, at a couple of sizes', () => {
    for (const kind of ALL_KINDS) {
      for (const size of [16, 64]) {
        const g = new PIXI.Graphics();
        expect(() => DRAW[kind](g, size, 0x3a6fb0), `${kind} @ ${size}px`).not.toThrow();
      }
    }
  });

  it('the escalating hourglass tiers actually draw different amounts of geometry', () => {
    const counts = (['hourglassSm', 'hourglassMd', 'hourglassLg'] as const).map((kind) => {
      const g = new PIXI.Graphics();
      DRAW[kind](g, 64, 0x3a6fb0);
      return g.geometry.graphicsData.length;
    });
    // Sm has 1 tick+1 grain, Md has 2 of each, Lg has 3 of each — strictly more draw calls per tier,
    // not just a text badge glued on top of one identical icon (the failure mode this guards).
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
  });

  it('armorHeavy draws strictly more geometry than the base armor it wraps', () => {
    const gArmor = new PIXI.Graphics();
    DRAW.armor(gArmor, 64, 0x3a6fb0);
    const gHeavy = new PIXI.Graphics();
    DRAW.armorHeavy(gHeavy, 64, 0x3a6fb0);
    expect(gHeavy.geometry.graphicsData.length).toBeGreaterThan(gArmor.geometry.graphicsData.length);
  });
});
