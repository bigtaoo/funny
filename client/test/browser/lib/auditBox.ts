// auditBox.ts — "what design rect will the client build for THIS viewport, and how do I judge it".
//
// Extracted from `portraitLayout.spec.ts` on 2026-09-14, when `rotateLayout.spec.ts` became the
// second spec needing it: a rotation sweep has to judge the SAME screen against two different
// design boxes, so it needs exactly this and nothing else from the layout sweep. Same split
// `lib/walk.ts` already made for navigation — `layoutStops.ts` holds where a sweep goes, `walk.ts`
// how it gets there, and this holds what shape it expects to find when it arrives.
import { auditOptionsFor, type AuditFinding, type AuditOptions } from '../../../src/testing/layoutAudit';

/** Short edge of both layouts' reference box, and the axis both fix. */
const REFERENCE_SHORT = 1080;
/** PortraitLayout's `REFERENCE_H` floor; LandscapeLayout's `REFERENCE_W` / `MAX_W` bounds. */
const PORTRAIT_MIN_LONG = 1920;
const LANDSCAPE_MIN_LONG = 1920;
const LANDSCAPE_MAX_LONG = 2592;

export interface ViewportSize { width: number; height: number }

/**
 * The design rect `createLayout` will build for this viewport — the two layouts' own sizing rules,
 * duplicated rather than imported because those modules pull `@nw/engine/config` and PIXI into a
 * Playwright process with no DOM. Both fix their SHORT axis at 1080 and let the long one track the
 * aspect: portrait never shorter than 1920, landscape between 1920 and 2592 (past which it
 * letterboxes on purpose — see LandscapeLayout's MAX_W).
 */
export function designBox(vp: ViewportSize): { w: number; h: number } {
  if (vp.width > vp.height) {
    const long = Math.round(REFERENCE_SHORT * (vp.width / vp.height));
    return { w: Math.min(LANDSCAPE_MAX_LONG, Math.max(LANDSCAPE_MIN_LONG, long)), h: REFERENCE_SHORT };
  }
  const long = Math.round(REFERENCE_SHORT * (vp.height / vp.width));
  return { w: REFERENCE_SHORT, h: Math.max(PORTRAIT_MIN_LONG, long) };
}

/** The design→screen scale `ScalingManager` will contain this viewport at. */
export function designScaleOf(vp: ViewportSize): number {
  const box = designBox(vp);
  return Math.min(vp.width / box.w, vp.height / box.h);
}

/** Audit options for one viewport — the shared helper, fed this shape's own design box. */
export function auditFor(vp: ViewportSize): AuditOptions {
  const box = designBox(vp);
  return auditOptionsFor(box.w, box.h, designScaleOf(vp));
}

/** One line per finding, short enough to read in a terminal failure. */
export function fmt(viewport: string, screen: string, f: AuditFinding): string {
  const r = (x: { x: number; y: number; w: number; h: number }): string =>
    `(${Math.round(x.x)},${Math.round(x.y)} ${Math.round(x.w)}x${Math.round(x.h)})`;
  const where = `${viewport} ${screen}`;
  if (f.kind === 'offscreen') return `${where}: offscreen "${f.a}" ${r(f.rectA)}`;
  if (f.kind === 'tiny') return `${where}: unreadable "${f.a}" ${f.frac}px ${f.b} ${r(f.rectA)}`;
  if (f.kind === 'placeholder') return `${where}: placeholder text "${f.a}" ${r(f.rectA)}`;
  if (f.kind === 'covered') {
    return `${where}: covered ${Math.round(f.frac * 100)}% "${f.a}" ${r(f.rectA)} by ${r(f.rectB)}`;
  }
  if (f.kind === 'overflow') return `${where}: overflow "${f.a}" ${r(f.rectA)} out of its box ${r(f.rectB)}`;
  return `${where}: overlap ${Math.round(f.frac * 100)}% "${f.a}" ${r(f.rectA)} x "${f.b}" ${r(f.rectB)}`;
}
