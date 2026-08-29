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
