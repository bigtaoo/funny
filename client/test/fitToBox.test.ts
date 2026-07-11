// Regression guard for the lobby hero silhouette sizing/centring, which broke
// twice (commits 0d7f90df, 4cb446fb) before landing. Both failures were in the
// fit math — which height to normalise, and centring against an assumed origin
// instead of the measured box — so we pin that math down here as a pure function.
//
// What this DOES cover: given a measured content box + target box, the result is
// always exactly `fraction` of the box height and centred on the box centre, for
// any content box including ones that overhang their origin asymmetrically (the
// real-world case: rig art reaching past the skeleton joints).
//
// What this does NOT cover: that StickmanRuntime.getRenderedLocalBounds() returns
// the correct box for a real .tao (that needs a real PIXI renderer, unavailable
// in the node test env — see vitest.config.ts). This guards the half that keeps
// regressing; the measurement half is verified by webpack build + a visual check.

import { describe, it, expect } from 'vitest';
import { fitContentToBox, type Bounds, type TargetBox } from '../src/render/fitToBox';

const BOX: TargetBox = { top: 100, height: 300, centerX: 500 };
const FRAC = 0.9;

/** Apply a fit to a content box and return the on-screen rect it produces. */
function rendered(content: Bounds, box: TargetBox, frac: number) {
  const fit = fitContentToBox(content, box, frac);
  return {
    height:  fit.scale * content.height,
    centerX: fit.x + fit.scale * (content.x + content.width / 2),
    centerY: fit.y + fit.scale * (content.y + content.height / 2),
  };
}

describe('fitContentToBox', () => {
  it('renders content at exactly `fraction` of the box height', () => {
    const r = rendered({ x: 0, y: 0, width: 80, height: 200 }, BOX, FRAC);
    expect(r.height).toBeCloseTo(FRAC * BOX.height, 5); // 270
  });

  it('centres content vertically on the box centre', () => {
    const r = rendered({ x: 0, y: 0, width: 80, height: 200 }, BOX, FRAC);
    // rounding of the integer container y can shift by at most half a pixel × scale.
    expect(r.centerY).toBeCloseTo(BOX.top + BOX.height / 2, 0); // 250
  });

  it('centres content horizontally on box.centerX', () => {
    const r = rendered({ x: 0, y: 0, width: 80, height: 200 }, BOX, FRAC);
    expect(r.centerX).toBeCloseTo(BOX.centerX, 0); // 500
  });

  // The exact bug from fix #2: an assumed "origin = feet, figure spans up" model
  // mis-centres whenever the art overhangs the origin unequally. A box whose
  // measured extent straddles the origin asymmetrically must STILL come out 90%
  // and centred — only possible when both scale and centre use the measured box.
  it('stays 90% + centred for a box that overhangs its origin asymmetrically', () => {
    const skewed: Bounds = { x: -30, y: -180, width: 60, height: 220 };
    const r = rendered(skewed, BOX, FRAC);
    expect(r.height).toBeCloseTo(FRAC * BOX.height, 5);       // 270
    expect(r.centerY).toBeCloseTo(BOX.top + BOX.height / 2, 0); // 250
    expect(r.centerX).toBeCloseTo(BOX.centerX, 0);             // 500
  });

  // The "six mismatched sizes" complaint: rigs with very different measured boxes must
  // all render at the SAME on-screen height. That holds iff height depends only on
  // fraction*box.height, never on the content's own height.
  it('gives every content box the same rendered height (size consistency)', () => {
    const shortWide: Bounds = { x: 0, y: 0, width: 300, height: 120 };
    const tallThin:  Bounds = { x: 0, y: 0, width: 40,  height: 260 };
    const hA = rendered(shortWide, BOX, FRAC).height;
    const hB = rendered(tallThin,  BOX, FRAC).height;
    expect(hA).toBeCloseTo(hB, 5);
    expect(hA).toBeCloseTo(FRAC * BOX.height, 5);
  });

  it('does not divide by zero on an empty content box', () => {
    const fit = fitContentToBox({ x: 0, y: 0, width: 0, height: 0 }, BOX, FRAC);
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(Number.isFinite(fit.x)).toBe(true);
    expect(Number.isFinite(fit.y)).toBe(true);
  });
});
