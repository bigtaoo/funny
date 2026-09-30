// Audit options for layoutAudit.ts. Kept out of that file because `auditLayout` is serialized by
// `Function.prototype.toString` into the page, and the value import below (the shipped legibility
// floor) must not sit next to it. layoutAudit.ts re-exports both names.
import { fontFloorDesignPx } from '../render/fontScale';
import type { AuditOptions } from './layoutAudit';

/**
 * Overlap thresholds — the only audit options that do not depend on the viewport.
 * `minFrac`: report an overlap only when it covers this fraction of the smaller label.
 * `minPx`: ...and at least this many square pixels. Together they ignore sub-pixel adjacency.
 */
export const OVERLAP_THRESHOLDS = { minFrac: 0.12, minPx: 40 } as const;

/**
 * Audit options for one shape. Everything is shared except the `tiny` gate, which is the viewport's
 * own legibility floor (render/fontScale.ts): the app lifts every font token to
 * `fontFloorDesignPx(scale)`, so nothing on screen may measure below it.
 *
 * Deriving it from the shipped function rather than restating a number is what makes this a gate on
 * the floor rather than a second opinion about it: re-tune `MIN_LEGIBLE_CSS_PX` and every sweep
 * demands the new floor on its next run.
 *
 * The two callers know the design box by different routes and neither can use the other's:
 * `portraitLayout.spec.ts` runs in a Playwright process with no DOM, so it re-derives the box from
 * the viewport size (importing `ScalingManager` would drag PIXI and `@nw/engine/config` in);
 * `entries/wechat-layout.ts` runs INSIDE the app and simply reads `layout.designWidth` and
 * `gameLayer.scale.x` off the live objects. Hence a function over three numbers rather than over a
 * viewport.
 */
export function auditOptionsFor(designW: number, designH: number, designScale: number): AuditOptions {
  return {
    ...OVERLAP_THRESHOLDS,
    designW,
    designH,
    minInkDesignPx: fontFloorDesignPx(designScale),
    minIconDesignPx: fontFloorDesignPx(designScale),
  };
}
