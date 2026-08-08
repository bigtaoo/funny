// Unit coverage for render/levelStars.ts — the shared "enhancement level as gold stars" widget
// (2026-08-08, see AUCTION_DESIGN.md's "装备强化等级显示+N文本" entry): extracted out of 5 independent
// duplicate implementations (EquipmentScene, CardScene x3, EquipmentScene/assign.ts), now also used by
// AuctionScene. Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree,
// no renderer. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { buildLevelStars, levelStarsText } from '../../src/render/levelStars';

describe('buildLevelStars — icon row', () => {
  it('draws exactly `count` star children', () => {
    expect(buildLevelStars(3, 1000).container.children).toHaveLength(3);
    expect(buildLevelStars(1, 1000).container.children).toHaveLength(1);
  });

  it('count=0 draws an empty container (no children, zero width)', () => {
    const { container, stars } = buildLevelStars(0, 1000);
    expect(container.children).toHaveLength(0);
    expect(stars).toHaveLength(0);
    expect(container.width).toBe(0);
  });

  it('a negative count is clamped to 0, not a negative loop bound', () => {
    const { container, stars } = buildLevelStars(-5, 1000);
    expect(container.children).toHaveLength(0);
    expect(stars).toHaveLength(0);
  });

  it('positions stars left-to-right spaced by size+gap, pivoted to each icon\'s own center', () => {
    const size = 20, gap = 5;
    const { stars } = buildLevelStars(3, 1000, size, gap);
    for (let i = 0; i < stars.length; i++) {
      const st = stars[i] as unknown as { x: number; y: number; pivot: { x: number; y: number } };
      expect(st.x).toBe(i * (size + gap) + size / 2);
      expect(st.y).toBe(size / 2);
      expect(st.pivot.x).toBe(size / 2);
      expect(st.pivot.y).toBe(size / 2);
    }
  });

  it('does not scale the row when it already fits within maxW', () => {
    const size = 14, gap = 3;
    const starsW = 3 * size + 2 * gap; // exact row width for count=3
    const { container } = buildLevelStars(3, starsW + 50, size, gap);
    expect(container.scale.x).toBe(1);
    expect(container.scale.y).toBe(1);
  });

  it('does not scale when the row width exactly equals maxW (boundary, not ">")', () => {
    const size = 14, gap = 3;
    const starsW = 3 * size + 2 * gap;
    const { container } = buildLevelStars(3, starsW, size, gap);
    expect(container.scale.x).toBe(1);
  });

  it('scales down to fit when the row overflows maxW', () => {
    const size = 14, gap = 3;
    const starsW = 5 * size + 4 * gap;
    const maxW = starsW / 2;
    const { container } = buildLevelStars(5, maxW, size, gap);
    expect(container.scale.x).toBeCloseTo(0.5, 5);
  });

  it('floors the scale at 0.01 instead of going to 0 or negative when maxW <= 0', () => {
    // A caller passing a stale/degenerate layout width (0 or negative) must never produce an
    // invisible (scale 0) or mirrored (negative scale) row — see the maxW<=0 guard's doc comment.
    const { container: atZero } = buildLevelStars(3, 0);
    expect(atZero.scale.x).toBe(0.01);
    const { container: negative } = buildLevelStars(3, -100);
    expect(negative.scale.x).toBe(0.01);
  });

  it('defaults to the shared gold color, and honors an explicit override', () => {
    // buildIcon caches/bakes by (kind,size,color) — two different colors must produce two
    // independently-created icons rather than one call silently reusing the other's tint.
    const gold = buildLevelStars(1, 1000, 14, 3);
    const red = buildLevelStars(1, 1000, 14, 3, 0xff0000);
    expect(gold.stars).toHaveLength(1);
    expect(red.stars).toHaveLength(1);
    expect(gold.stars[0]).not.toBe(red.stars[0]);
  });
});

describe('levelStarsText — plain-text star row', () => {
  it('level 0 renders no stars at all (not a bare "+0"-equivalent empty run)', () => {
    expect(levelStarsText(0, 9)).toBe('');
  });

  it('a negative level also renders nothing', () => {
    expect(levelStarsText(-3, 9)).toBe('');
  });

  it('renders exactly `level` stars when within maxLevel', () => {
    expect(levelStarsText(3, 9)).toBe('★★★');
    expect(levelStarsText(1, 9)).toBe('★');
  });

  it('clamps to maxLevel when level exceeds it', () => {
    expect(levelStarsText(15, 9)).toBe('★'.repeat(9));
  });

  it('renders exactly maxLevel stars at the boundary', () => {
    expect(levelStarsText(9, 9)).toBe('★'.repeat(9));
  });
});
