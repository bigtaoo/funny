// Regression coverage for the legendary gacha-reveal comet trail's alpha falloff
// (client/src/scenes/GachaScene/trail.ts trailDotFalloff, driven by reveal.ts's buildTrailDots).
//
// 2026-08-03 fix: the falloff formula used to divide by TRAIL_SPAN a second time on top of the
// position formula (`u`), which already applied it — `1 - (i/n)/TRAIL_SPAN` clamps to 0 once
// i/n > TRAIL_SPAN (~0.42), so roughly the back half of every 28-dot trail was constructed at
// alpha=0 and never revisited (update() only rewrites position/tint). Extracted into a standalone
// pure function so this arithmetic is directly testable without spinning up the whole GachaScene.
import { describe, it, expect } from 'vitest';
import { TRAIL_DOTS, TRAIL_SPAN, trailDotFalloff } from '../src/scenes/GachaScene/trail';

describe('trailDotFalloff', () => {
  it('the head dot (i=0) is fully opaque', () => {
    expect(trailDotFalloff(0, TRAIL_DOTS)).toBe(1);
  });

  it('the tail-end dot (i=n-1) is nearly transparent, not exactly the head', () => {
    const last = trailDotFalloff(TRAIL_DOTS - 1, TRAIL_DOTS);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(0.1);
  });

  it('regression: dots past the old TRAIL_SPAN cutoff (~42% through the trail) are still visible, not alpha=0', () => {
    // Under the old (buggy) formula, any i/n > TRAIL_SPAN produced exactly 0. Assert several dots
    // well past that fraction are still > 0.
    const pastCutoffIndices = [
      Math.ceil(TRAIL_SPAN * TRAIL_DOTS) + 1, // just past the old cutoff
      Math.floor(TRAIL_DOTS * 0.7),
      Math.floor(TRAIL_DOTS * 0.9),
    ];
    for (const i of pastCutoffIndices) {
      expect(trailDotFalloff(i, TRAIL_DOTS)).toBeGreaterThan(0);
    }
  });

  it('is monotonically non-increasing as i grows (a smooth comet tail, no fade-then-brighten)', () => {
    let prev = trailDotFalloff(0, TRAIL_DOTS);
    for (let i = 1; i < TRAIL_DOTS; i++) {
      const cur = trailDotFalloff(i, TRAIL_DOTS);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });

  it('never negative and never exceeds 1 across the full dot range', () => {
    for (let i = 0; i < TRAIL_DOTS; i++) {
      const v = trailDotFalloff(i, TRAIL_DOTS);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
