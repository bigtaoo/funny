// Guards the small-size branch of render/emblemIcon.ts's buildEmblemIcon.
//
// History: the 2026-08-25 fix made small badges (~20-38px, everything except the picker grid and
// ProfilePopup-scale previews) render as a solid accent-colour disc with the un-tinted line art
// knocked out on top, padded inward ~18% a side. The 2026-08-29 report ("选了背景之后，图标就几乎
// 看不到了") showed that knockout icon is still illegible — and by construction it always would be:
// the padding caps it at `size * 0.64`, strictly under BADGE_MEDALLION_MAX (44px), which is itself
// documented as the size below which even a *flat, unpadded* tint fades out. So below the threshold
// this is now just the disc — a clean colour dot, no knockout icon attempt.
//
// Every consumer (header/info-band/rows/ProfilePopup/world-map badge) calls this one function, so
// this is the single place that behavior needs covering — emblemBadgeDisplay.ui.ts and friends all
// mock buildEmblemIcon away entirely (the real atlas never finishes decoding under this same
// headless PIXI adapter — see that file's header comment), so none of them exercise this branch.
// This file mocks only the atlas layer (to a texture that's valid synchronously), so
// buildEmblemIcon's own Sprite/Graphics construction runs for real.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts) —
// needed here (rather than the plain-node test/render suite) because PIXI.Texture.WHITE lazily
// creates a canvas the first time it's touched, which requires the adapter's stubbed
// settings.ADAPTER.createCanvas.
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

vi.mock('../../src/render/atlas/emblemAtlas', () => ({
  emblemAtlas: {
    isReady: () => true,
    load: async () => {},
    getTexture: (name: string) => (name === 'emblem_owl' ? PIXI.Texture.WHITE : null),
    frameNames: () => ['emblem_owl'],
  },
}));

import { buildEmblemIcon, EMBLEM_COLORS } from '../../src/render/emblemIcon';

const KEY = 'emblem_owl' as const;
const TINT = EMBLEM_COLORS[3]!; // blue — the swatch circled in the bug report's screenshot

describe('buildEmblemIcon — size-gated plain sprite vs solid colour dot', () => {
  it('at a roomy size (picker grid, ≥44px) returns the plain accent-tinted sprite, unchanged', () => {
    const node = buildEmblemIcon(KEY, 60, TINT);
    expect(node).toBeInstanceOf(PIXI.Sprite);
    const sprite = node as PIXI.Sprite;
    expect(sprite.tint).toBe(TINT);
    expect(sprite.width).toBe(60);
    expect(sprite.height).toBe(60);
  });

  it('right at the threshold (44px) still takes the plain-sprite branch', () => {
    expect(buildEmblemIcon(KEY, 44, TINT)).toBeInstanceOf(PIXI.Sprite);
  });

  it('below the threshold (header/roster-row sizes, e.g. 30px) returns a plain colour dot, not a knockout icon', () => {
    const node = buildEmblemIcon(KEY, 30, TINT);
    expect(node).toBeInstanceOf(PIXI.Graphics);
    expect(node).not.toBeInstanceOf(PIXI.Sprite);
    // No nested icon sprite anymore — the whole point of the fix. A Graphics dot has no children.
    expect((node as PIXI.Graphics).children).toHaveLength(0);
  });

  it('a tiny size (world-map corner badge, e.g. 10px) still produces a positive-size dot, not a degenerate/negative one', () => {
    const node = buildEmblemIcon(KEY, 10, TINT) as PIXI.Graphics;
    expect(node).toBeInstanceOf(PIXI.Graphics);
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  it('returns null when the atlas has no texture for the key (not loaded yet), at any size', () => {
    expect(buildEmblemIcon('emblem_bear' as never, 30, TINT)).toBeNull();
    expect(buildEmblemIcon('emblem_bear' as never, 60, TINT)).toBeNull();
  });

  it('a bare destroy() (the pattern every real call site uses) destroys the dot with no leaked children', () => {
    // header.ts's `for (const n of core.headerExtras) n.destroy();`, tokens.ts's
    // `entry.badge.sprite.destroy()` — neither passes `{ children: true }`. Harmless now: a plain
    // Graphics dot has nothing to cascade to.
    const dot = buildEmblemIcon(KEY, 30, TINT) as PIXI.Graphics;
    dot.destroy();
    expect(dot.destroyed).toBe(true);
  });

  it('the plain-sprite branch (≥44px) is unaffected — a bare destroy() destroys it directly, same as before', () => {
    const sprite = buildEmblemIcon(KEY, 60, TINT) as PIXI.Sprite;
    sprite.destroy();
    expect(sprite.destroyed).toBe(true);
  });
});
