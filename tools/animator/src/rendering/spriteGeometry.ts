// Pure geometry for a bone's sprite quad in world space — mirrors PIXI's own sprite
// transform exactly (see Renderer.updateSprites: anchor → scale → rotate → translate),
// so hit-testing (InteractionController) and drawing (Renderer) can never drift apart.
// Zero imports, zero PIXI dependency: callers pass plain numbers (texture width/height
// instead of a PIXI.Texture) so this stays trivially unit-testable.

export interface Vec2 { x: number; y: number }

/** A bone's sprite fully resolved to world-space transform inputs. */
export interface SpriteFrame {
  pivotX: number; pivotY: number;   // world position the sprite is pinned to (bone pos.sx/sy)
  rotationRad: number;              // world rotation in radians (bone world angle + binding.rotation)
  scaleX: number; scaleY: number;   // effective scale (flipX folded in as a sign on scaleX)
  anchorX: number; anchorY: number; // binding anchor, fraction of texture size (0=left/top, 1=right/bottom; may exceed 0–1)
  texW: number; texH: number;       // texture size in px
}

/** Minimal shape of a SpriteBinding this module needs — kept structural (no import
 *  from core/types) so this file has zero dependencies of its own. */
export interface BindingLike {
  anchorX: number;
  anchorY: number;
  rotation?: number;
  scaleX?:   number;
  scaleY?:   number;
  flipX?:    boolean;
}

export function rotateVec(x: number, y: number, rad: number): Vec2 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Build a SpriteFrame from a bone's rest-pose pivot/world-angle and its binding —
 *  the same inputs Renderer.updateSprites uses to place the PIXI.Sprite. */
export function bindingToSpriteFrame(
  poseSx: number, poseSy: number, poseWa: number,
  binding: BindingLike,
  texW: number, texH: number,
): SpriteFrame {
  return {
    pivotX: poseSx,
    pivotY: poseSy,
    rotationRad: ((poseWa + (binding.rotation ?? 0)) * Math.PI) / 180,
    scaleX: (binding.flipX ? -1 : 1) * (binding.scaleX ?? 1),
    scaleY: binding.scaleY ?? 1,
    anchorX: binding.anchorX,
    anchorY: binding.anchorY,
    texW, texH,
  };
}

/** World position of a texture-pixel-space point (0,0 = image top-left). */
export function localPixelToWorld(f: SpriteFrame, px: number, py: number): Vec2 {
  const lx = (px - f.anchorX * f.texW) * f.scaleX;
  const ly = (py - f.anchorY * f.texH) * f.scaleY;
  const r  = rotateVec(lx, ly, f.rotationRad);
  return { x: f.pivotX + r.x, y: f.pivotY + r.y };
}

/** The sprite's four corners in world space, TL → TR → BR → BL. */
export function spriteCorners(f: SpriteFrame): [Vec2, Vec2, Vec2, Vec2] {
  return [
    localPixelToWorld(f, 0, 0),
    localPixelToWorld(f, f.texW, 0),
    localPixelToWorld(f, f.texW, f.texH),
    localPixelToWorld(f, 0, f.texH),
  ];
}

/** Rotation-handle position: a fixed world-pixel distance beyond the mid-point of the
 *  quad's top edge (TL→TR), along the sprite's local "up" direction. */
export function rotationHandlePos(f: SpriteFrame, distance = 22): Vec2 {
  const [tl, tr] = spriteCorners(f);
  const midX = (tl.x + tr.x) / 2, midY = (tl.y + tr.y) / 2;
  const up   = rotateVec(0, -1, f.rotationRad);
  return { x: midX + up.x * distance, y: midY + up.y * distance };
}

/**
 * Anchor-drag math: given the sprite frame captured at drag-start (rotation/scale/
 * texture size are all fixed for the duration — only the binding's rotation-drag
 * changes rotation, never concurrently with an anchor-drag) plus the mouse's start
 * and current stage position, returns the new anchor.
 *
 * The anchor is "which texture pixel sits at the fixed world pivot" (see
 * `SpriteBinding`'s doc comment — deliberately no separate offset field), so
 * dragging the image toward the cursor means that pixel moves AWAY from the pivot:
 * the anchor moves the opposite way from the visual drag. The mouse delta is first
 * un-rotated (anchor lives in unscaled texture-pixel space, which doesn't rotate
 * with the sprite) then un-scaled, hence the extra `rotateVec(..., -rotationRad)`
 * and the `/ (scale * texSize)` division below.
 */
export function computeAnchorDrag(
  startMouse: Vec2, startAnchor: Vec2, rotationRad: number,
  scaleX: number, scaleY: number, texW: number, texH: number,
  x: number, y: number,
): Vec2 {
  const worldDx = x - startMouse.x;
  const worldDy = y - startMouse.y;
  const local = rotateVec(worldDx, worldDy, -rotationRad);
  return {
    x: startAnchor.x - local.x / (scaleX * texW),
    y: startAnchor.y - local.y / (scaleY * texH),
  };
}

/** Point-in-convex-quad test via cross-product sign consistency (works for either
 *  winding order, which flipX can produce). */
export function pointInQuad(px: number, py: number, quad: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Inverse of `localPixelToWorld`: which texture pixel sits under a world-space point.
 *  Returns null for a degenerate sprite (zero scale on either axis), where the mapping
 *  isn't invertible. */
export function worldToLocalPixel(f: SpriteFrame, x: number, y: number): Vec2 | null {
  if (f.scaleX === 0 || f.scaleY === 0) return null;
  const r = rotateVec(x - f.pivotX, y - f.pivotY, -f.rotationRad);
  return {
    x: r.x / f.scaleX + f.anchorX * f.texW,
    y: r.y / f.scaleY + f.anchorY * f.texH,
  };
}

/** One texture's alpha channel, flattened to a single byte per pixel and possibly
 *  downsampled (see ImageController.ALPHA_MASK_MAX) — `w`/`h` are the MASK's own size,
 *  not the texture's, so every reader has to scale through the texture size it's testing
 *  against. Built by ImageController; consumed by `findSpriteAt`'s hit-test. */
export interface AlphaMask {
  w: number;
  h: number;
  data: Uint8Array;   // length w*h, alpha 0–255, row-major
}

/** Minimum alpha (0–255) a pixel needs for a click on it to count as hitting that sprite.
 *  Low rather than zero: a PNG exported from a paint tool carries a halo of near-zero
 *  alpha around every stroke, and treating that as solid would hand back most of the
 *  quad we're trying to see through. */
export const MIN_HIT_ALPHA = 8;

/** Alpha (0–255) at a texture-pixel coordinate, nearest-neighbour through the mask's own
 *  (possibly smaller) resolution. Out-of-range coordinates read as fully transparent. */
export function alphaAt(mask: AlphaMask, texW: number, texH: number, px: number, py: number): number {
  if (texW <= 0 || texH <= 0) return 0;
  const mx = Math.floor((px / texW) * mask.w);
  const my = Math.floor((py / texH) * mask.h);
  if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return 0;
  return mask.data[my * mask.w + mx];
}
