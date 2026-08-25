// Guards the 2026-08-25 "family/sect badge is basically invisible in the top bar" fix
// (render/emblemIcon.ts's buildEmblemIcon): below BADGE_MEDALLION_MAX the fine white-line-art
// emblem art is illegible once tinted onto cream paper at header/roster-row sizes (~20-38px), so
// small sizes now render as a solid accent-colour disc with the (un-tinted) line art knocked out
// on top instead of a plain tinted sprite. Every consumer (header/info-band/rows/ProfilePopup/
// world-map badge) calls this one function, so this is the single place that behavior needs
// covering — emblemBadgeDisplay.ui.ts and friends all mock buildEmblemIcon away entirely (the
// real atlas never finishes decoding under this same headless PIXI adapter — see that file's
// header comment), so none of them exercise this branch. This file mocks only the atlas layer
// (to a texture that's valid synchronously), so buildEmblemIcon's own Sprite/Graphics/Container
// construction runs for real.
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

describe('buildEmblemIcon — size-gated medallion vs plain tinted sprite', () => {
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

  it('below the threshold (header/roster-row sizes, e.g. 30px) returns a medallion: a coloured disc + an UN-tinted icon on top', () => {
    const node = buildEmblemIcon(KEY, 30, TINT);
    expect(node).toBeInstanceOf(PIXI.Container);
    expect(node).not.toBeInstanceOf(PIXI.Sprite); // Sprite extends Container — must not fall through
    const badge = node as PIXI.Container;
    expect(badge.children).toHaveLength(2);

    const [disc, sprite] = badge.children as [PIXI.Graphics, PIXI.Sprite];
    expect(disc).toBeInstanceOf(PIXI.Graphics);
    expect(sprite).toBeInstanceOf(PIXI.Sprite);
    // The whole point of the fix: the icon itself stays default-white, not coloured — the accent
    // colour lives on the disc behind it, not on a faint line that would fade into the paper again.
    expect(sprite.tint).toBe(0xffffff);
    // Inset within the disc (padding), not edge-to-edge.
    expect(sprite.x).toBeGreaterThan(0);
    expect(sprite.y).toBeGreaterThan(0);
    expect(sprite.width).toBeLessThan(30);
  });

  it('a tiny size (world-map corner badge, e.g. 10px) still produces a positive-size disc, not a degenerate/negative one', () => {
    const node = buildEmblemIcon(KEY, 10, TINT) as PIXI.Container;
    expect(node.children).toHaveLength(2);
    const sprite = node.children[1] as PIXI.Sprite;
    expect(sprite.width).toBeGreaterThan(0);
  });

  it('returns null when the atlas has no texture for the key (not loaded yet), at any size', () => {
    expect(buildEmblemIcon('emblem_bear' as never, 30, TINT)).toBeNull();
    expect(buildEmblemIcon('emblem_bear' as never, 60, TINT)).toBeNull();
  });
});
