// Pins what `buildIcon` DOES with the two tables it dispatches over, which is the load-bearing half
// of the 2026-08-25 batch-7 design and the half no other test touches:
//
//   - a RASTER TAB kind's `color` is only a light/dark hint — it is consumed by `tabIconVariant` to
//     pick one of three inks baked at pack time, and must NOT reach the sprite;
//   - an INK kind's `color` is the literal ink — it must be handed through untouched, because for
//     these kinds the colour IS the information (medal gold/silver/bronze is the leaderboard rank,
//     star's colour is the gacha rarity, the title wall's gold means "equipped", HUD ink's blue means
//     "our ink"). Route one of them through `tabIconVariant` by mistake and every one of those
//     distinctions silently collapses to the same grey, with no build error and no crash.
//
// `test/render/icons.test.ts` asserts the two tables are disjoint; `inkIconArt.test.ts` asserts each
// table matches the art on disk. Neither notices if the DISPATCH gets them backwards, which is the
// realistic regression: a future "let's unify the colour handling" refactor is exactly the shape of
// change that would do it. Both submodules are faked here so this stays a pure contract test with no
// pixi/texture graph — the fake `tabIconVariant` is the real luma formula, copied rather than
// imported for the same reason rewardIcon.test.ts copies it (faking it would hollow out the test).
// Run: npm test
import { describe, it, expect, vi, beforeEach } from 'vitest';

type RasterArgs = [url: string, w: number, h?: number];
type InkArgs = [url: string, s: number, color: number];
const buildRasterTabIcon = vi.fn((..._a: RasterArgs) => ({ raster: true }));
const buildInkIcon = vi.fn((..._a: InkArgs) => ({ ink: true }));
const preloadTabIconTextures = vi.fn(() => Promise.resolve());
const preloadInkIconTextures = vi.fn(() => Promise.resolve());

vi.mock('../../src/render/icons/tabIconRaster', () => ({
  TAB_ICON_RASTER: {
    pvpTabIcon: { active: 'pvp-active', inactive: 'pvp-inactive', content: 'pvp-content' },
  },
  tabIconVariant: (color: number): 'active' | 'inactive' => {
    const r = ((color >> 16) & 0xff) / 255, g = ((color >> 8) & 0xff) / 255, b = (color & 0xff) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b >= 0.70 ? 'active' : 'inactive';
  },
  buildRasterTabIcon: (...a: RasterArgs) => buildRasterTabIcon(...a),
  preloadTabIconTextures: () => preloadTabIconTextures(),
  BACK_ARROW_ART: { accent: 'back-accent', active: 'back-active' },
  BACK_ARROW_ASPECT: 128 / 65,
}));
vi.mock('../../src/render/icons/inkIconRaster', () => ({
  INK_ICON_ART: { medal: 'medal-master', titleKing: 'titleking-master' },
  INK_ICON_ALIASES: [],
  buildInkIcon: (...a: InkArgs) => buildInkIcon(...a),
  preloadInkIconTextures: () => preloadInkIconTextures(),
}));

const { buildIcon, preloadIconArt } = await import('../../src/render/icons');

const GOLD = 0xd4a030;   // LeaderboardScene's rank-1 tint / TitlesScene's "equipped"
const C_LIGHT = 0xdddddd; // "I sit on a dark fill"
const C_DARK = 0x2c2c2a;  // "I sit on paper"

beforeEach(() => {
  buildRasterTabIcon.mockClear();
  buildInkIcon.mockClear();
  preloadTabIconTextures.mockClear();
  preloadInkIconTextures.mockClear();
});

describe('buildIcon — an INK kind gets its colour literally', () => {
  it('hands the requested colour straight to buildInkIcon, untouched', () => {
    buildIcon('medal', 24, GOLD);
    expect(buildRasterTabIcon).not.toHaveBeenCalled();
    expect(buildInkIcon).toHaveBeenCalledTimes(1);
    expect(buildInkIcon).toHaveBeenCalledWith('medal-master', 24, GOLD);
  });

  // Gold luma is below tabIconVariant's 0.70 cut, so a kind that went through the tab table would
  // come back as the de-emphasised paper grey — three leaderboard ranks rendered identically. This
  // case is here to fail loudly if `medal` (or any tinted kind) is ever moved between tables.
  it('does not let a low-luma tint fall through to a variant pick', () => {
    buildIcon('medal', 24, GOLD);
    expect(buildInkIcon.mock.calls[0]![2]).toBe(GOLD);
  });

  it('ignores opts.variant — that knob only means anything for the baked tab inks', () => {
    buildIcon('titleKing', 24, GOLD, { variant: 'content' });
    expect(buildInkIcon).toHaveBeenCalledWith('titleking-master', 24, GOLD);
  });
});

describe('buildIcon — a RASTER TAB kind gets a variant, not a colour', () => {
  it('reads a light colour as "on a dark fill" and picks the white art', () => {
    buildIcon('pvpTabIcon', 24, C_LIGHT);
    expect(buildInkIcon).not.toHaveBeenCalled();
    expect(buildRasterTabIcon).toHaveBeenCalledWith('pvp-active', 24);
  });

  it('reads a dark colour as "on paper" and picks the grey art', () => {
    buildIcon('pvpTabIcon', 24, C_DARK);
    expect(buildRasterTabIcon).toHaveBeenCalledWith('pvp-inactive', 24);
  });

  it('never forwards the colour itself — the art is baked, not tinted', () => {
    buildIcon('pvpTabIcon', 24, GOLD);
    expect(buildRasterTabIcon.mock.calls[0]).toHaveLength(2);
    expect(buildRasterTabIcon.mock.calls[0]).not.toContain(GOLD);
  });

  it('lets an explicit opts.variant override the colour hint (the content ink)', () => {
    buildIcon('pvpTabIcon', 24, C_LIGHT, { variant: 'content' });
    expect(buildRasterTabIcon).toHaveBeenCalledWith('pvp-content', 24);
  });
});

describe('buildIcon — shared contract', () => {
  it('rounds a fractional size once, before either builder sees it', () => {
    buildIcon('medal', 23.6, C_DARK);
    buildIcon('pvpTabIcon', 23.6, C_DARK);
    expect(buildInkIcon.mock.calls[0]![1]).toBe(24);
    expect(buildRasterTabIcon.mock.calls[0]![1]).toBe(24);
  });
});

// The reason `preloadTabIconTextures` alone is not enough any more: the ink kinds are NOT in the tab
// table, so a page that warms only that half paints its equipment affixes / dingbats / title glyphs
// as empty boxes until something re-renders it. `test/tabIconWarmupCallSites.test.ts` checks the
// scenes call the right function; this checks the function itself still warms both halves.
describe('preloadIconArt', () => {
  it('warms both tables, not just the tab icons', async () => {
    await preloadIconArt();
    expect(preloadTabIconTextures).toHaveBeenCalledTimes(1);
    expect(preloadInkIconTextures).toHaveBeenCalledTimes(1);
  });
});
