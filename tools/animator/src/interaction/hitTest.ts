// Pure geometry/hit-test helpers used by InteractionController on mousedown — point-to-segment
// distance, nearest-bone-at-a-point, skin-mode handle hit-test, and sprite hit-test. Split out of
// InteractionController.ts (2026-08-31) purely to keep that file under the 500-line convention:
// none of these depend on controller/canvas/window state, so they were already free functions,
// just re-exported from InteractionController.ts for callers/tests that still import them from
// there.
import type { WorldPositions, SpriteBinding } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';
import {
  bindingToSpriteFrame, rotationHandlePos, spriteCorners, pointInQuad,
  worldToLocalPixel, alphaAt, MIN_HIT_ALPHA,
  type AlphaMask,
} from '../rendering/spriteGeometry';

const HIT_RADIUS        = 10;  // bone-segment hit radius (animate-mode rotate drag)
const HANDLE_HIT_RADIUS = 9;   // skin-mode handle hit radius (length tip / rotation knob)

// Pre-computed reversed draw order for front-first hit testing (computed lazily
// after Skeleton static init runs).
let _drawOrderReversed: readonly string[] | null = null;
function getDrawOrderReversed(): readonly string[] {
  if (!_drawOrderReversed) _drawOrderReversed = [...Skeleton.DRAW_ORDER].reverse();
  return _drawOrderReversed;
}

export function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nearest hit-testable bone at a stage point (head circle first, then closest
 *  tubular-bone segment within HIT_RADIUS, front-first draw order). Doesn't
 *  depend on controller state — free function so it's testable without wiring
 *  up canvas/window listeners. */
export function findBoneAt(
  x: number,
  y: number,
  worldPose: WorldPositions,
): string | null {
  // Check head first (circle)
  const head = worldPose.get('head');
  if (head) {
    const dx = x - head.ex, dy = y - head.ey;
    if (Math.sqrt(dx * dx + dy * dy) <= Skeleton.HEAD_R + 4) return 'head';
  }

  // Check tubular bones — closest segment in reversed draw order (front first)
  let best: string | null = null;
  let bestDist = Infinity;

  for (const boneId of getDrawOrderReversed()) {
    if (boneId === 'head') continue;
    if (!Skeleton.SELECTABLE_BONES.includes(boneId)) continue;
    const pos = worldPose.get(boneId);
    if (!pos) continue;

    const dist = pointToSegmentDist(x, y, pos.sx, pos.sy, pos.ex, pos.ey);
    if (dist < HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      best = boneId;
    }
  }

  return best;
}

export type SkinHandleKind = 'length' | 'rotate';

/** Which skin-mode handle (if any) sits under a stage point, for the CURRENTLY
 *  selected bone — its length tip (always, when the bone has length and isn't the
 *  head), or its binding's rotation knob (only in Sprite preview, when it has a
 *  binding + loaded texture). Doesn't build the resulting drag state (the caller
 *  still needs live state — `AppState.getLengthScale`, the binding's own
 *  `rotation` — to do that) or depend on controller state itself — free function
 *  so it's testable without wiring up canvas listeners. */
export function findSkinHandleAt(
  x: number,
  y: number,
  boneId: string,
  worldPose: WorldPositions,
  previewMode: 'skeleton' | 'sprite',
  binding: SpriteBinding | undefined,
  texture: { width: number; height: number } | undefined,
): SkinHandleKind | null {
  const bone = Skeleton.BONE_MAP.get(boneId);
  const pos  = worldPose.get(boneId);
  if (!bone || !pos) return null;

  if (bone.len > 0 && !bone.isHead && Math.hypot(x - pos.ex, y - pos.ey) <= HANDLE_HIT_RADIUS) {
    return 'length';
  }

  if (previewMode === 'sprite' && binding && texture) {
    const frame  = bindingToSpriteFrame(pos.sx, pos.sy, pos.wa, binding, texture.width, texture.height);
    const handle = rotationHandlePos(frame);
    if (Math.hypot(x - handle.x, y - handle.y) <= HANDLE_HIT_RADIUS) return 'rotate';
  }

  return null;
}

export interface SpriteHitOptions {
  /** Per-slot alpha mask lookup. A sprite that has one is hit only where its pixels are
   *  actually painted; one that doesn't (mask still decoding, or undecodable) falls back
   *  to its plain quad, i.e. the pre-alpha behaviour. */
  getAlphaMask?: (boneId: string) => AlphaMask | undefined;
  /** The currently selected bone. When the click lands on it, it keeps the selection even
   *  if a higher-zOrder sprite also covers that point — picking a part from the bone list
   *  and then clicking it on canvas must not hand the selection to whatever is in front. */
  preferBone?: string | null;
}

/** Nearest sprite (front-to-back by zOrder) whose *painted pixels* contain a stage point —
 *  Skin-mode's "click the image directly" hit-test. The quad is only the first pass: the
 *  spine's texture rectangle swallows both shoulders, so a quad-only test made every part
 *  under it unclickable however the bone list was used. Doesn't depend on controller state —
 *  free function so it's testable without wiring up canvas listeners. `getTexture` is typed
 *  structurally (not PIXI.Texture) to keep this module PIXI-free. */
export function findSpriteAt(
  x: number,
  y: number,
  worldPose: WorldPositions,
  bindings: ReadonlyMap<string, SpriteBinding>,
  getTexture: (boneId: string) => { width: number; height: number } | undefined,
  opts: SpriteHitOptions = {},
): string | null {
  const candidates = [...bindings.entries()]
    .filter(([boneId]) => getTexture(boneId))
    .sort((a, b) => b[1].zOrder - a[1].zOrder);   // highest zOrder (frontmost) first

  let frontmost: string | null = null;

  for (const [boneId, binding] of candidates) {
    const pose    = worldPose.get(boneId);
    const texture = getTexture(boneId);
    if (!pose || !texture) continue;
    const frame = bindingToSpriteFrame(pose.sx, pose.sy, pose.wa, binding, texture.width, texture.height);
    if (!pointInQuad(x, y, spriteCorners(frame))) continue;

    const mask = opts.getAlphaMask?.(boneId);
    if (mask) {
      const local = worldToLocalPixel(frame, x, y);
      if (!local) continue;
      if (alphaAt(mask, frame.texW, frame.texH, local.x, local.y) < MIN_HIT_ALPHA) continue;
    }

    if (boneId === opts.preferBone) return boneId;   // sticky selection beats zOrder
    if (frontmost === null) frontmost = boneId;
  }

  return frontmost;
}
