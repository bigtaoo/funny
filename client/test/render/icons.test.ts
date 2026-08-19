// Guards the 2026-07-07 icons.ts split (855→123: draw fns moved into icons/*, dispatch became the
// exported DRAW record). Asserts the DRAW table resolves a live function for every IconKind — the
// residual risk after the split is a draw fn that fails to import (resolves to undefined at runtime,
// which the Record<IconKind,…> type cannot catch). No pixi rendering here, so no GL/canvas needed;
// lives in test/render only because importing icons.ts pulls pixi.js-legacy.
// Run: npm test — the default suite's `test/**/*.test.ts` include picks this up. There is no
// separate render suite: the never-run vitest.render.config.ts this header used to warn about
// was deleted 2026-08-15.
import { describe, it, expect } from 'vitest';
import { DRAW, tabIconVariant, type DrawableIconKind } from '../../src/render/icons';
// Palette values are inlined rather than imported from `render/sketchUi` (HubTabs' `ui`) and
// `scenes/LobbyScene/core` (`C`). That began as a hard constraint under the old render config,
// which lacked the aliases those module graphs need; under the default config both now import
// cleanly (verified 2026-08-15), so it is kept only to hold this dispatch-table guard independent
// of the much heavier scene/palette graphs. Each case names its source constant so a palette
// retune is still traceable here.

// Exhaustive map of every DrawableIconKind (IconKind minus the raster-only tab icons, which skip
// DRAW entirely — see icons.ts's TAB_ICON_RASTER). Typed Record<DrawableIconKind, true> so the
// compiler forces it to stay in sync with the union — adding a drawable kind without updating this
// map fails to compile.
const ALL_KINDS: Record<DrawableIconKind, true> = {
  book: true, globe: true, coin: true, trophy: true, castle: true, pencils: true,
  coins: true, coinStack: true, coinSack: true, coinChest: true,
  scrap: true, lead: true, binding: true,
  atk: true, hp: true, armor: true, armorHeavy: true, spd: true, atkspd: true,
  brush: true,
  swords: true, replay: true, share: true, home: true,
  flag: true, desk: true, cabinet: true, hammer: true,
  hourglassSm: true, hourglassMd: true, hourglassLg: true,
  tag: true, capsule: true, cards: true, star: true, lock: true, medal: true, zoom: true, gift: true,
  close: true, check: true, play: true, backArrow: true,
  titleBronze: true, titleSilver: true, titleGold: true, titlePlatinum: true, titleDiamond: true,
  titleStar: true, titleMaster: true, titleGrandmaster: true, titleKing: true,
  titleChampion: true, titleTop3: true,
};

describe('icons DRAW dispatch table', () => {
  const kinds = Object.keys(ALL_KINDS) as DrawableIconKind[];

  it('resolves a live draw function for every DrawableIconKind (guards icons/* import wiring)', () => {
    for (const kind of kinds) {
      expect(typeof DRAW[kind], kind).toBe('function');
    }
  });

  it('has exactly the DrawableIconKind union as keys — no orphan or missing entries', () => {
    expect(Object.keys(DRAW).sort()).toEqual(kinds.sort());
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

// A real PIXI.Graphics needs the headless ADAPTER (canvas/document stubs) that only the `test:ui`
// harness installs (see test/harness/pixiHeadless.ts) — constructing one under plain `environment:
// 'node'` throws "document is not defined" before a single draw call runs. The actual geometry
// smoke-check (every draw fn runs without throwing, incl. the hourglassSm/Md/Lg + armorHeavy tier
// variants added in SLG_DESIGN_LOG.md §63) lives in test/ui/icons.ui.ts instead.
