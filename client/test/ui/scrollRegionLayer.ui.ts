// The one invariant ui/widgets/scrollRegionLayer.ts exists to protect.
//
// A masked scroll region needs the clip to be a SIBLING of the moving layer. Make it a child and the
// mask travels with the content, so the region clips nothing — and nothing throws, nothing logs, the
// list just quietly paints outside its viewport (which is exactly the bug the family roster had for
// months: its bottom row painted over the portrait nav bar). The helper was extracted on 2026-08-25
// so seven call sites stopped retyping that pairing; this pins the pairing itself.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { scrollRegionLayer } from '../../src/ui/widgets/scrollRegionLayer';

describe('scrollRegionLayer', () => {
  it('masks the layer with a clip that is its sibling, not its child', () => {
    const parent = new PIXI.Container();
    const view = { x: 12, y: 40, w: 300, h: 200 };
    const { layer, clip } = scrollRegionLayer(parent, view);

    expect(layer.mask).toBe(clip);
    // Both in the parent…
    expect(clip.parent).toBe(parent);
    expect(layer.parent).toBe(parent);
    // …and the clip is NOT inside the layer, which is the whole point: a child mask would be
    // translated along with the content and clip nothing.
    expect(layer.children).toHaveLength(0);
    // Clip first, layer second: the content paints over the (invisible) clip's own geometry.
    expect(parent.children.indexOf(clip)).toBeLessThan(parent.children.indexOf(layer));
  });

  it('clips to exactly the requested viewport, and moving the layer does not move the clip', () => {
    const parent = new PIXI.Container();
    const view = { x: 12, y: 40, w: 300, h: 200 };
    const { layer, clip } = scrollRegionLayer(parent, view);

    const before = clip.getBounds();
    expect(Math.round(before.x)).toBe(view.x);
    expect(Math.round(before.y)).toBe(view.y);
    expect(Math.round(before.width)).toBe(view.w);
    expect(Math.round(before.height)).toBe(view.h);

    layer.y = -137; // scroll
    const after = clip.getBounds();
    expect(Math.round(after.y)).toBe(view.y);
    expect(Math.round(after.height)).toBe(view.h);
  });
});
