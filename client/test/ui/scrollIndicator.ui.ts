// Coverage for the shared ScrollIndicator widget (client/src/ui/widgets/ScrollIndicator.ts),
// applied to every scrollable page. The draw call must be a no-op when content fits, and the
// thumb geometry must track the scroll position/ratio. scrollThumbGeometry() is the pure math
// behind the draw so it can be asserted without a renderer; drawScrollIndicator() is exercised
// under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawScrollIndicator, scrollThumbGeometry } from '../../src/ui/widgets/ScrollIndicator';

const view = { x: 100, y: 200, w: 800, h: 600 };

describe('scrollThumbGeometry', () => {
  it('returns null when there is nothing to scroll (scrollMax <= 0)', () => {
    expect(scrollThumbGeometry(view, 0, 0)).toBeNull();
    expect(scrollThumbGeometry(view, 0, -50)).toBeNull();
  });

  it('returns null for a degenerate viewport', () => {
    expect(scrollThumbGeometry({ x: 0, y: 0, w: 0, h: 600 }, 5, 100)).toBeNull();
    expect(scrollThumbGeometry({ x: 0, y: 0, w: 800, h: 0 }, 5, 100)).toBeNull();
  });

  it('sits on the right edge of the viewport, inside it', () => {
    const g = scrollThumbGeometry(view, 0, 400)!;
    // barX = view.x + view.w - width - inset = 100 + 800 - 5 - 3
    expect(g.barX).toBe(892);
    expect(g.barX + g.width).toBeLessThanOrEqual(view.x + view.w);
  });

  it('thumb length shrinks as content grows relative to the viewport', () => {
    const small = scrollThumbGeometry(view, 0, 200)!; // content 800, ratio 0.75
    const large = scrollThumbGeometry(view, 0, 5000)!; // content 5600, ratio ~0.11
    expect(small.thumbH).toBeGreaterThan(large.thumbH);
    expect(small.thumbH).toBeLessThanOrEqual(view.h);
  });

  it('never shorter than minThumb even for very long content', () => {
    const g = scrollThumbGeometry(view, 0, 100000)!;
    expect(g.thumbH).toBeGreaterThanOrEqual(24);
  });

  it('thumb rides from top (scrollY 0) to bottom (scrollY = scrollMax)', () => {
    const max = 400;
    const top = scrollThumbGeometry(view, 0, max)!;
    const bottom = scrollThumbGeometry(view, max, max)!;
    expect(top.thumbY).toBe(view.y); // pinned to the viewport top
    expect(bottom.thumbY + bottom.thumbH).toBe(view.y + view.h); // flush to the bottom
    const mid = scrollThumbGeometry(view, max / 2, max)!;
    expect(mid.thumbY).toBeGreaterThan(top.thumbY);
    expect(mid.thumbY).toBeLessThan(bottom.thumbY);
  });

  it('clamps an out-of-range scrollY into the track', () => {
    const max = 400;
    const over = scrollThumbGeometry(view, max + 9999, max)!;
    const under = scrollThumbGeometry(view, -9999, max)!;
    expect(over.thumbY + over.thumbH).toBe(view.y + view.h);
    expect(under.thumbY).toBe(view.y);
  });
});

describe('drawScrollIndicator', () => {
  it('adds nothing to the parent when content fits', () => {
    const parent = new PIXI.Container();
    const g = drawScrollIndicator(parent, view, 0, 0);
    expect(g).toBeNull();
    expect(parent.children.length).toBe(0);
  });

  it('adds a Graphics to the parent when scrollable', () => {
    const parent = new PIXI.Container();
    const g = drawScrollIndicator(parent, view, 100, 400);
    expect(g).not.toBeNull();
    expect(parent.children).toContain(g);
  });
});
