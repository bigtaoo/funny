// tileStyle — the editor's copy of the game client's tile→art mapping. DESIGN.md §6.3 makes
// art parity a hard requirement, and the 2026-07-06/07-08 "the mountain brush doesn't show"
// investigation burned a day on exactly this layer, so pin the mapping down.
import { describe, expect, it } from 'vitest';
import {
  biomeGroundTint,
  obstacleTextureName,
  RES_COLORS,
  RES_TEX_TINT,
  terrainFill,
  TERRAIN_COLORS,
  TERRAIN_TEX_ALPHA,
  TERRAIN_TEX_ALPHA_DEFAULT,
  terrainTextureName,
  lerpHexColor,
} from '../src/tiles/tileStyle';

describe('terrainTextureName', () => {
  it('paints rivers as river art and mountains as mountain art (never the position hash)', () => {
    // The 2026-07-06 regression: obstacles with a known kind used to fall through to the hash.
    for (const [tx, ty] of [[0, 0], [1, 0], [7, 13], [100, 101]]) {
      expect(terrainTextureName('obstacle', tx!, ty!, 'river')).toBe('terrain_river');
      expect(terrainTextureName('obstacle', tx!, ty!, 'mountain')).toBe('terrain_mountain');
    }
  });

  it('falls back to a position hash only for an obstacle with no declared kind', () => {
    // Procedural obstacles carry no obstacleKind; the hash keeps neighbours visually varied.
    expect(terrainTextureName('obstacle', 0, 0)).toBe('terrain_mountain'); // (0*31+0*17)%2 === 0
    expect(terrainTextureName('obstacle', 1, 0)).toBe('terrain_river'); // 31%2 === 1
    expect(terrainTextureName('obstacle', 0, 1)).toBe('terrain_river'); // 17%2 === 1
  });

  it('renders crossings over the terrain they span', () => {
    expect(terrainTextureName('bridge', 5, 5)).toBe('terrain_river');
    expect(terrainTextureName('plankway', 5, 5)).toBe('terrain_mountain');
  });

  it('maps the special tile types to their own textures', () => {
    expect(terrainTextureName('familyKeep', 0, 0)).toBe('terrain_keep');
    expect(terrainTextureName('center', 0, 0)).toBe('terrain_center');
    expect(terrainTextureName('stronghold', 0, 0)).toBe('terrain_stronghold');
  });

  it('defaults everything else to grass', () => {
    for (const type of ['neutral', 'resource', 'territory', 'base']) {
      expect(terrainTextureName(type, 3, 4)).toBe('terrain_grass');
    }
  });

  it('obstacleTextureName agrees with the obstacle branch of terrainTextureName', () => {
    expect(obstacleTextureName('river')).toBe(terrainTextureName('obstacle', 0, 0, 'river'));
    expect(obstacleTextureName('mountain')).toBe(terrainTextureName('obstacle', 0, 0, 'mountain'));
  });
});

describe('terrainFill', () => {
  it('uses the per-resource color for a resource tile', () => {
    expect(terrainFill('resource', 'ink')).toBe(RES_COLORS.ink);
    expect(terrainFill('resource', 'sticker')).toBe(RES_COLORS.sticker);
  });

  it('falls back to the generic resource color when no resType is given', () => {
    expect(terrainFill('resource')).toBe(TERRAIN_COLORS.resource);
  });

  it('uses the type color for non-resource tiles', () => {
    expect(terrainFill('obstacle')).toBe(TERRAIN_COLORS.obstacle);
    expect(terrainFill('center')).toBe(TERRAIN_COLORS.center);
  });

  it('covers every tile type — no lookup silently falls through to neutral', () => {
    for (const type of ['neutral', 'resource', 'territory', 'familyKeep', 'center', 'base', 'obstacle', 'bridge', 'plankway', 'stronghold'] as const) {
      expect(TERRAIN_COLORS[type]).toBeTypeOf('number');
    }
  });
});

describe('TERRAIN_TEX_ALPHA', () => {
  // Load-bearing, not cosmetic: obstacles draw semi-transparent so their weave recedes into the
  // paper background. The 2026-07-08 fix pinned these against the cream canvas (DESIGN.md §8).
  it('keeps mountain/river below the default so they recede into the paper', () => {
    expect(TERRAIN_TEX_ALPHA.terrain_mountain!).toBeLessThan(TERRAIN_TEX_ALPHA_DEFAULT);
    expect(TERRAIN_TEX_ALPHA.terrain_river!).toBeLessThan(TERRAIN_TEX_ALPHA_DEFAULT);
  });

  it('keeps them high enough that the hand-drawn linework stays legible', () => {
    // 0.5 was the value that collapsed the art into a flat block; the pass settled on 0.92.
    expect(TERRAIN_TEX_ALPHA.terrain_mountain!).toBeGreaterThan(0.8);
    expect(TERRAIN_TEX_ALPHA.terrain_river!).toBeGreaterThan(0.8);
  });
});

describe('biomeGroundTint', () => {
  it('is deterministic for a given tile and seed', () => {
    expect(biomeGroundTint(120, 340, 7)).toBe(biomeGroundTint(120, 340, 7));
  });

  it('returns a valid 24-bit color', () => {
    for (const [x, y] of [[0, 0], [10, 900], [749, 749], [1499, 3]]) {
      const c = biomeGroundTint(x!, y!, 42);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
      expect(Number.isInteger(c)).toBe(true);
    }
  });

  it('keys off the tile PROVINCE, not the tile — neighbours inside a province share the tint', () => {
    // The 2026-07-15 rewrite: the ground wash is the province's leaning resource (hard province
    // borders), decoupled from the per-tile resType carried by the motif icon.
    const c = biomeGroundTint(700, 700, 3);
    expect(biomeGroundTint(701, 700, 3)).toBe(c);
    expect(biomeGroundTint(700, 701, 3)).toBe(c);
  });

  it('produces more than one tint across the map (provinces do lean differently)', () => {
    const tints = new Set<number>();
    for (let x = 50; x < 1450; x += 137) {
      for (let y = 50; y < 1450; y += 137) tints.add(biomeGroundTint(x, y, 3));
    }
    expect(tints.size).toBeGreaterThan(1);
  });

  it('only ever emits colors from the resource tint palette (t is always 0 post-rewrite)', () => {
    const palette = new Set(Object.values(RES_TEX_TINT));
    for (let x = 20; x < 1480; x += 211) {
      for (let y = 20; y < 1480; y += 211) expect(palette.has(biomeGroundTint(x, y, 11))).toBe(true);
    }
  });
});

// lerpHexColor is the one function in this file with no reachable caller: biomeGroundTint's only
// other branch wins unconditionally now that biomeMixAt always returns t=0. It is kept on purpose
// (so the call site survives a future re-enable of biome blending — see the note on
// biomeGroundTint), and that is exactly why it needs a test: an unreachable helper cannot be
// caught being wrong by anything else, and a channel-order slip in a packed-RGB lerp is invisible
// by inspection. These cases also document what the blend is SUPPOSED to do, for whoever turns it
// back on.
describe('lerpHexColor (retained for a future biome cross-fade — currently unreachable)', () => {
  it('returns the endpoints exactly at t=0 and t=1', () => {
    expect(lerpHexColor(0x102030, 0xa0b0c0, 0)).toBe(0x102030);
    expect(lerpHexColor(0x102030, 0xa0b0c0, 1)).toBe(0xa0b0c0);
  });

  it('blends each channel independently, not the packed integer', () => {
    // Packed-int interpolation would carry between channels; per-channel must not. Midpoint of
    // 0x0000ff and 0x00ff00 is 0x008080 (both channels at 0x7f.8 -> rounds to 0x80), NOT the
    // 0x007f80 you get from lerping the numbers 255 and 65280 and re-splitting.
    expect(lerpHexColor(0x0000ff, 0x00ff00, 0.5)).toBe(0x008080);
    // Red left untouched while green/blue move proves the channels are actually separated.
    expect(lerpHexColor(0xff0000, 0xff00ff, 0.5)).toBe(0xff0080);
  });

  it('rounds per channel and never overflows into the next one', () => {
    // 0x01 -> 0x02 at t=0.5 is 1.5, rounding UP to 2 (Math.round), and the byte above it must not
    // pick up a carry.
    expect(lerpHexColor(0x000101, 0x000202, 0.5)).toBe(0x000202);
    for (let i = 0; i <= 10; i++) {
      const c = lerpHexColor(0x000000, 0xffffff, i / 10);
      const [r, g, b] = [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(c).toBeLessThanOrEqual(0xffffff);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });

  it('blends the real RES_TEX_TINT palette into a color between the two', () => {
    const mid = lerpHexColor(RES_TEX_TINT.paper!, RES_TEX_TINT.ink!, 0.5);
    for (const shift of [16, 8, 0]) {
      const ch = (v: number) => (v >> shift) & 0xff;
      const lo = Math.min(ch(RES_TEX_TINT.paper!), ch(RES_TEX_TINT.ink!));
      const hi = Math.max(ch(RES_TEX_TINT.paper!), ch(RES_TEX_TINT.ink!));
      expect(ch(mid)).toBeGreaterThanOrEqual(lo);
      expect(ch(mid)).toBeLessThanOrEqual(hi);
    }
    expect(mid).not.toBe(RES_TEX_TINT.paper!);
    expect(mid).not.toBe(RES_TEX_TINT.ink!);
  });
});
