// Guards `render/icons.ts`'s dispatch. It used to guard a third thing as well — that the `DRAW`
// record resolved a live draw function for every procedural kind — but batch 7 of the AI-art
// programme (design/product/tab-icon-art-prompts-batch7.md, 2026-08-25) replaced the last 44
// procedural glyphs, emptied `DRAW`, and deleted `icons/{motifs,equipment,slg,ui,titles,currency}.ts`
// with it. What is left to protect is the two-table dispatch `buildIcon` now does, and the colour
// threshold the tab table's variant pick hangs off.
//
// The per-table art/naming contracts live next door, one file per family, because their failure
// modes and their on-disk halves are different: `tabIconContentVariant.test.ts` (three baked inks
// per tab icon) and `inkIconArt.test.ts` (one tinted master per ink icon).
// No pixi rendering here, so no GL/canvas needed; lives in test/render only because importing
// icons.ts pulls pixi.js-legacy. Run: npm test.
import { describe, it, expect } from 'vitest';
import { INK_ICON_ART, TAB_ICON_RASTER, tabIconVariant, type IconKind } from '../../src/render/icons';
// Palette values below are inlined rather than imported from `render/sketchUi` (HubTabs' `ui`) and
// `scenes/LobbyScene/core` (`C`), to hold this dispatch guard independent of the much heavier
// scene/palette module graphs. Each case names its source constant so a palette retune is still
// traceable here.

describe('buildIcon dispatch — every IconKind resolves to exactly one table', () => {
  const inkKinds = Object.keys(INK_ICON_ART) as IconKind[];
  const rasterKinds = Object.keys(TAB_ICON_RASTER) as IconKind[];

  it('has both tables populated (guards a table that failed to import and resolved to {})', () => {
    expect(inkKinds.length).toBeGreaterThan(0);
    expect(rasterKinds.length).toBeGreaterThan(0);
  });

  // `buildIcon` checks TAB_ICON_RASTER first and falls through to INK_ICON_ART, so a kind in both
  // silently loses its ink row — and with it the literal `color` an ink kind's callers rely on. The
  // exhaustive per-table naming contracts are in inkIconArt.test.ts; this is the dispatch half.
  it('never lists the same kind in both tables', () => {
    expect(inkKinds.filter((k) => rasterKinds.includes(k))).toEqual([]);
  });

});

// Raster tab icons (`TAB_ICON_RASTER`) are coloured at PACK time into a white `*_active.png` for dark
// fills and a #686868 `*_inactive.png` for paper fills, so `buildIcon`'s `color` argument can only act
// as a hint about which of the two the caller needs. That pick used to be `color === 0xffffff`, which
// silently gave the lobby bottom nav — a near-black bar whose slots ask for `C.light` — the paper-grey
// art, making 养成/商城 unreadable (2026-08-15). These cases pin the threshold from BOTH sides: widen
// it and HubTabs' paper cells go white-on-white, narrow it and the dark-bar regression comes back.
describe('tabIconVariant — which pre-baked ink a requested colour asks for', () => {
  const cases: Array<[string, number, 'active' | 'inactive']> = [
    ['0xffffff — HubTabs active cell, on its C.dark fill',              0xffffff, 'active'],
    ['C.light 0xdddddd — lobby bottom nav slots, on the C.cover bar',   0xdddddd, 'active'],
    ['C.light 0xdddddd — auction category chip, active (C.dark fill)',  0xdddddd, 'active'],
    ['ui.mid 0x686868 — HubTabs inactive cell, on paper',               0x686868, 'inactive'],
    ["C.mid 0x888888 — LobbyScene's own lighter mid grey",              0x888888, 'inactive'],
    ['C.dark 0x2c2c2a — auction category chip, inactive (on paper)',    0x2c2c2a, 'inactive'],
  ];

  for (const [label, color, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(tabIconVariant(color)).toBe(expected);
    });
  }

  it("is monotonic in lightness — no grey at or below LobbyScene's C.mid asks for the white art", () => {
    for (let v = 0; v <= 0x88; v += 0x08) {
      expect(tabIconVariant((v << 16) | (v << 8) | v), `#${v.toString(16)}`).toBe('inactive');
    }
  });
});

// There used to be a companion `test/ui/icons.ui.ts` here: a geometry smoke check that ran every
// draw function under the headless PIXI adapter, because a real `PIXI.Graphics` cannot be built
// under plain `environment: 'node'`. It went with the draw functions in batch 7 — the escalating
// hourglassSm/Md/Lg and armorHeavy tiers it existed to pin (SLG_DESIGN_LOG.md §63) are now a
// property of the ART, checked by eye at 28px when the images land, not of any geometry math.
