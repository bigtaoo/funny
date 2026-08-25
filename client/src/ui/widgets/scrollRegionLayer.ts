// scrollRegionLayer — the four lines every masked scroll region in this codebase writes by hand.
//
// A scrollable list needs a container whose contents move and a clip that does NOT, so the clip has
// to be a SIBLING of the layer rather than its child (a mask that is a child moves with the content
// and clips nothing). Getting that backwards is silent — the list just never clips — so the pairing
// lives here instead of being retyped per call site: FamilyScene/SectScene's roster + channel
// columns and their pick / join-request modals all open their region through this (2026-08-25).
//
// Deliberately does NOT own the scroll state, the culling or the indicator: those differ per caller
// (page columns register a cheap-scroll band in their scene's repaint.ts, modals keep their own
// offset). This is the display-object pairing only, which is exactly the part that was identical
// everywhere.
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';

/**
 * Open a masked scroll region inside `parent`.
 *
 * Both objects are added to `parent`: the clip first, then the layer. Draw content into `layer` at
 * absolute (unscrolled) coordinates and move the layer to scroll — the clip stays put, so the
 * viewport is fixed at `view`.
 */
export function scrollRegionLayer(parent: PIXI.Container, view: Rect): {
  layer: PIXI.Container;
  clip: PIXI.Graphics;
} {
  const clip = new PIXI.Graphics().beginFill(0xffffff).drawRect(view.x, view.y, view.w, view.h).endFill();
  const layer = new PIXI.Container();
  layer.mask = clip;
  parent.addChild(clip, layer);
  return { layer, clip };
}
