/**
 * stickmanDraft.ts — procedural "stickman plus" drawn along the .tao skeleton.
 *
 * Art direction §5.5 (north star): the procedural pen and the character pen are
 * the SAME pen. We walk the 11 real `.tao` bones (the very rig the animator and
 * StickmanRuntime use), and stroke each bone as a tapered hand-drawn limb, with
 * joint pips and a scrawled head — a draft figure that is born already bound to
 * the skeleton. A unit with no authored `.tao` asset (Ironclad / Runner, or any
 * stickman type before its bundle loads) renders as this sketch instead of a
 * flat circle. Later a GIMP-fleshed `.tao` simply replaces it, bone for bone.
 *
 * Faction ink (blue = us / red = enemy) is the line color, so the draft obeys
 * the same friend/foe readability rule as everything else (§3.2).
 */
import * as PIXI from 'pixi.js-legacy';
import { Skeleton } from './stickman/skeleton';
import type { ResolvedBoneTransform } from './stickman/types';
import { SketchPen } from './sketch';
import { palette, factionInk } from './theme';
import { Side } from '@nw/engine/types';
import { bakeLazy } from './bake';

const EMPTY_XF: ResolvedBoneTransform = {
  rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
};

/** Rest-pose world positions, computed once (pure FK on empty transforms). */
function restPose() {
  const xf = new Map<string, ResolvedBoneTransform>();
  for (const b of Skeleton.BONE_DEFS) xf.set(b.id, EMPTY_XF);
  return Skeleton.computeFK(0, 0, xf);
}
const REST = restPose();

/** Bounds of the rest figure (bone-space), computed once for normalization. */
const BOUNDS = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pose of REST.values()) {
    for (const [x, y] of [[pose.sx, pose.sy], [pose.ex, pose.ey]] as const) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  // Pad for the head circle + limb thickness.
  const pad = 18;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
})();
const FIG_W = BOUNDS.maxX - BOUNDS.minX;
const FIG_H = BOUNDS.maxY - BOUNDS.minY;

/**
 * Draw the draft figure into `g`, faction-inked, scaled so its full height is
 * `targetH` px and centered on (0,0) horizontally / sitting on its feet.
 *
 * @param side    render side → ink color (Bottom = blue, Top = red).
 * @param targetH desired pixel height of the whole figure.
 * @param seed    pen seed (stable scrawl per unit type).
 */
export function drawStickmanDraft(
  g: PIXI.Graphics, side: Side, targetH: number, seed: number,
): void {
  const ink   = side === Side.Top ? factionInk.enemy : factionInk.friend;
  const scale = targetH / FIG_H;
  const pen   = new SketchPen(g, seed >>> 0 || 1);

  // Bone-space → centered local pixels. Figure centered on its X mid, feet near
  // the bottom; we translate so the skeleton root sits at ~0.35·targetH below 0.
  const midX = (BOUNDS.minX + BOUNDS.maxX) / 2;
  const tx = (x: number): number => (x - midX) * scale;
  const ty = (y: number): number => (y - (BOUNDS.minY + BOUNDS.maxY) / 2) * scale;

  // Limbs: tapered tube strokes, thickness from each bone's outerW.
  for (const bone of Skeleton.BONE_DEFS) {
    if (bone.id === 'root' || bone.isHead) continue;
    const pose = REST.get(bone.id);
    if (!pose) continue;
    const w = Math.max(2, (bone.outerW ?? 8) * scale * 0.55);
    pen.stroke(
      [{ x: tx(pose.sx), y: ty(pose.sy) }, { x: tx(pose.ex), y: ty(pose.ey) }],
      { color: ink, width: w, taper: 0.5, double: false },
    );
  }

  // Joint pips — small ink circles at each bone start (shoulders/hips/knees…).
  for (const bone of Skeleton.BONE_DEFS) {
    if (bone.id === 'root' || bone.isHead) continue;
    const pose = REST.get(bone.id)!;
    pen.circle(tx(pose.sx), ty(pose.sy), Math.max(1.4, 2.4 * scale), {
      color: ink, width: 1.4, double: false,
    });
  }

  // Scrawled head — a wobbled circle at the head tip + a single pencil eye dot
  // toward the facing direction (the figure faces right by rest convention).
  const head = REST.get('head');
  if (head) {
    const hr = Math.max(5, 13 * scale);
    pen.circle(tx(head.ex), ty(head.ey), hr, { color: ink, width: 1.8 });
    g.beginFill(palette.pencil, 0.9);
    g.drawCircle(tx(head.ex) + hr * 0.35, ty(head.ey) - hr * 0.1, Math.max(1, hr * 0.16));
    g.endFill();
  }
}

/** Natural figure aspect (width / height) for callers sizing a bounding box. */
export const STICKMAN_DRAFT_ASPECT = FIG_W / FIG_H;

/**
 * Padding around the scaled figure bounds, in bake pixels — covers the stroke width (pens draw
 * centered on the path, so a limb can extend half its width past {@link BOUNDS}) plus `SketchPen`'s
 * hand-drawn jitter. Derived here so the bake size and the draw offset always agree; a caller must
 * NOT hardcode this — see {@link draftBakeSize}.
 */
const DRAFT_PAD = 8;

/**
 * Bake-texture size for a draft figure at `targetH` — the pixel bounds {@link drawStickmanDraft}
 * actually needs, scaled from {@link FIG_W}/{@link FIG_H} (the same normalization the live draw
 * uses) plus {@link DRAFT_PAD}. Exported so a bone-proportion change can't silently crop the bake:
 * whoever calls this always gets the size that matches the current skeleton, not a stale constant.
 */
export function draftBakeSize(targetH: number): { w: number; h: number } {
  const scale = targetH / FIG_H;
  return { w: Math.ceil(FIG_W * scale) + DRAFT_PAD * 2, h: Math.ceil(targetH) + DRAFT_PAD * 2 };
}

/**
 * Baked texture of the draft figure — `(side, targetH, seed)` is the whole input, so the same
 * combination (one per unit type × render side, ~24 total) always hits the cache after the first
 * spawn. Returns null with no bake renderer wired (headless tests), in which case the caller must
 * fall back to drawing {@link drawStickmanDraft} live.
 *
 * `pageScale` is deliberately NOT passed: this is small per-unit chrome (kilobytes), and the unit
 * container it rides on animates its own `scale` (spawn pop, hit flash), where a device-exact
 * texture would visibly soften — the same call as `hpBar.ts`'s atlas (ADR-073).
 */
export function draftTexture(side: Side, targetH: number, seed: number): PIXI.Texture | null {
  const { w, h } = draftBakeSize(targetH);
  return bakeLazy(`stickman draft ${side}:${targetH}:${seed}`, () => {
    const g = new PIXI.Graphics();
    drawStickmanDraft(g, side, targetH, seed);
    g.x = w / 2;
    g.y = h / 2;
    return g;
  }, w, h);
}
