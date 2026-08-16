// Guards the 2026-08-15 reward-icon unification (render/rewardIcon.ts). Every reward row in the
// game (daily check-in / daily weekly chest / battle pass / events / recharge / mail attachments)
// used to hand-roll its own `kind → IconKind` table, and three of those kinds (`card`/`equipment`/
// `skin`) were still resolving to the *procedural* SketchPen glyphs long after AI line art existed
// — the weekly-chest tab drew a program-drawn shield right under a real AI-drawn material bitmap
// (user bug report). The regression this test blocks is someone mapping a reward kind back onto a
// procedural `IconKind` (or onto no picture at all) instead of the shared AI-backed resolver.
//
// No pixi rendering here — the assertions are on the resolver's *routing*, not on pixels. Lives in
// test/render only because importing rewardIcon.ts pulls pixi.js-legacy.
// Run: npm test — the default suite's `test/**/*.test.ts` include picks this up. There is no
// separate render suite (vitest.render.config.ts was deleted 2026-08-15; see icons.test.ts).
import { describe, it, expect, vi } from 'vitest';

// All three builders share the real `(kind, size, color)` shape. Spell the params out (rather than
// `vi.fn(() => …)`) so vitest infers a 3-tuple for `mock.calls` — a zero-arg mock infers `[]` and
// every `calls[0][0]` assertion below becomes a TS2493 under `npm run typecheck`.
type BuildIconArgs = [kind: string, size: number, color: number];
const buildIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'drawn' }));
const buildCoinIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'coin' }));
const buildMaterialIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'material' }));

vi.mock('../../src/render/icons', () => ({
  buildIcon: (...a: BuildIconArgs) => buildIcon(...a),
  preloadTabIconTextures: () => Promise.resolve(),
}));
vi.mock('../../src/render/atlas/coinIconAtlas', () => ({
  buildCoinIcon: (...a: BuildIconArgs) => buildCoinIcon(...a),
  loadCoinIconAtlas: () => Promise.resolve(),
}));
vi.mock('../../src/render/atlas/materialAtlas', () => ({
  buildMaterialIcon: (...a: BuildIconArgs) => buildMaterialIcon(...a),
  loadMaterialAtlas: () => Promise.resolve(),
}));

const { buildRewardIcon, coinIconTier, materialKind } = await import('../../src/render/rewardIcon');

/** The raster AI tab-icon kinds the three item rewards must reuse — never `cards`/`armor`/`brush`. */
const AI_ITEM_ICON: Record<string, string> = {
  card: 'rosterIcon',
  equipment: 'equipIcon',
  skin: 'skinIcon',
};

describe('buildRewardIcon — single source of truth for reward pictures', () => {
  it.each(Object.entries(AI_ITEM_ICON))(
    'routes a %s reward to the AI %s art, not a procedural glyph',
    (kind, iconKind) => {
      buildIcon.mockClear();
      const out = buildRewardIcon({ kind, count: 1 }, 40, 0x336644);
      expect(out).not.toBeNull();
      expect(buildIcon).toHaveBeenCalledTimes(1);
      expect(buildIcon.mock.calls[0][0]).toBe(iconKind);
    },
  );

  it('routes coins through buildCoinIcon (AI coin atlas), never buildIcon', () => {
    buildIcon.mockClear(); buildCoinIcon.mockClear();
    buildRewardIcon({ kind: 'coins', count: 20 }, 40, 0xd4a030);
    expect(buildCoinIcon).toHaveBeenCalledTimes(1);
    expect(buildIcon).not.toHaveBeenCalled();
  });

  it('lets a caller override the coin tier (RechargeScene\'s coarser payout scale)', () => {
    buildCoinIcon.mockClear();
    buildRewardIcon({ kind: 'coins', count: 60 }, 40, 0xd4a030, { coinKind: 'coinChest' });
    expect(buildCoinIcon.mock.calls[0][0]).toBe('coinChest');
  });

  it('routes materials through buildMaterialIcon (AI material atlas), by id and by bare kind', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', id: 'binding', count: 3 }, 40, 0x336644);
    buildRewardIcon({ kind: 'lead', count: 3 }, 40, 0x336644);
    expect(buildMaterialIcon.mock.calls.map((c) => c[0])).toEqual(['binding', 'lead']);
  });

  it('falls back to scrap for an unknown material id, or to null when the caller opts out', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', id: 'mat_unknown', count: 1 }, 40, 0x336644);
    expect(buildMaterialIcon.mock.calls[0][0]).toBe('scrap');
    // EventScene / mail want a text-only row rather than a wrong picture.
    expect(buildRewardIcon({ kind: 'material', id: 'mat_unknown', count: 1 }, 40, 0x336644,
      { materialFallback: null })).toBeNull();
  });

  it('returns null (no picture, caller draws a bare "+N") for stamina and unknown kinds', () => {
    expect(buildRewardIcon({ kind: 'stamina', count: 5 }, 40, 0x336644)).toBeNull();
    expect(buildRewardIcon({ kind: 'something_new', count: 1 }, 40, 0x336644)).toBeNull();
  });
});

describe('coinIconTier / materialKind', () => {
  it('escalates the coin pile with the payout size', () => {
    expect([10, 40, 80, 150, 300].map(coinIconTier))
      .toEqual(['coin', 'coins', 'coinStack', 'coinSack', 'coinChest']);
  });

  it('accepts only the short material ids the server actually sends', () => {
    expect(['scrap', 'lead', 'binding'].map(materialKind)).toEqual(['scrap', 'lead', 'binding']);
    // `mat_`-prefixed ids are gacha's SaveData namespace, never a mail/reward attachment id.
    expect(materialKind('mat_lead')).toBeNull();
    expect(materialKind(undefined)).toBeNull();
  });
});
