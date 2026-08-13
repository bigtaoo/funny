// StickmanRuntime's per-frame pose application, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). Takes a narrow `PoseHost` — the runtime
// fields these two functions read (all `public` on StickmanRuntime now; a `private` field can't
// satisfy an external module's structural interface, same visibility bump every mixin→composition/
// form① conversion in this codebase has needed) — instead of closing over `this`. Neither function
// reassigns any of these collections, only mutates individual sprite properties in place, so
// everything below is read-only from this module's point of view.
import * as PIXI from 'pixi.js-legacy';
import { sampleClip } from './interpolate';
import { Skeleton } from './skeleton';
import { getShadowTexture } from './shadow';
import type { GearPlacement } from './gearOverlay';
import type { AnimationClip } from './types';
import type { TaoAsset } from './runtimeTypes';

export interface PoseHost {
  readonly asset: TaoAsset;
  readonly sprites: Map<string, PIXI.Sprite>;
  readonly outlineSprites: Map<string, PIXI.Sprite>;
  readonly outlineFlashing: boolean;
  readonly gearSprites: Array<{ sprite: PIXI.Graphics; placement: GearPlacement }>;
  readonly currentClip: AnimationClip | null;
  readonly time: number;
}

export function applyPose(host: PoseHost): void {
  if (!host.currentClip) return;

  const transforms = sampleClip(host.currentClip, host.time);
  const worldPos   = Skeleton.computeFK(0, 0, transforms, host.asset.boneLengthScales);

  for (const [boneId, sprite] of host.sprites) {
    // ── Shadow attachment point — special rendering ───────────────────────
    if (boneId === 'shadow') {
      applyShadowPose(host, sprite, worldPos);
      continue;
    }

    // ── Normal bone sprite — composite formula (matches animator Renderer.ts)
    //   sprite.x        = bone_pivot.x + kf.translateX + binding.offsetX
    //   sprite.y        = bone_pivot.y + kf.translateY + binding.offsetY
    //   sprite.rotation = (bone_wa + kf.rotation + binding.rotation) * PI/180
    //   sprite.scale    = kf.scale × binding.scale  (× -1 for flipX)
    const pose    = worldPos.get(boneId);
    const binding = host.asset.bindings.get(boneId);
    const xform   = transforms.get(boneId);
    if (!pose || !binding) continue;

    sprite.x = pose.sx + (xform?.translateX ?? 0) + binding.offsetX;
    sprite.y = pose.sy + (xform?.translateY ?? 0) + binding.offsetY;

    sprite.rotation = (
      (pose.wa + (xform?.rotation ?? 0) + binding.rotation) * Math.PI
    ) / 180;

    sprite.scale.set(
      (binding.flipX ? -1 : 1) * (xform?.scaleX ?? 1) * binding.scaleX,
      (xform?.scaleY ?? 1) * binding.scaleY,
    );

    const alpha   = xform?.alpha ?? 1;
    sprite.alpha   = alpha;
    sprite.visible = alpha > 0;

    // While a hit flash is active, the outline sprite shares the bone's
    // pivot/transform; its own (bordered) anchor was pre-computed so identical
    // x/y/rotation/scale align them. Skipped entirely when not flashing.
    if (host.outlineFlashing) {
      const outline = host.outlineSprites.get(boneId);
      if (outline) {
        outline.x        = sprite.x;
        outline.y        = sprite.y;
        outline.rotation = sprite.rotation;
        outline.scale.set(sprite.scale.x, sprite.scale.y);
        outline.visible  = alpha > 0;
      }
    }
  }

  // ── Equipment overlay glyphs (§20.4) — reuse the FK we just computed ───────
  // Translate-only decals anchored to a bone; mirroring + scale come from the
  // container transform (same as the body sprites). Skipped entirely when the
  // unit carries no gear, so an unequipped swarm pays nothing.
  for (const { sprite, placement } of host.gearSprites) {
    const pose = worldPos.get(placement.bone)
      ?? worldPos.get('spine')
      ?? worldPos.get('root');
    if (!pose) { sprite.visible = false; continue; }
    const ax = placement.anchor === 'mid' ? (pose.sx + pose.ex) / 2 : pose.ex;
    const ay = placement.anchor === 'mid' ? (pose.sy + pose.ey) / 2 : pose.ey;
    sprite.x       = ax + placement.ox;
    sprite.y       = ay + placement.oy;
    sprite.visible = true;
  }
}

/**
 * Position and scale the shadow sprite according to the attachment point data.
 * Matches the animator's Renderer.ts shadow rendering logic:
 *   position = parentBone.tip + (offsetX, offsetY)
 *   scaleX   = (shadowW * 2) / tex.width
 *   scaleY   = (shadowH * 2) / tex.height
 */
function applyShadowPose(
  host:     PoseHost,
  sprite:   PIXI.Sprite,
  worldPos: ReturnType<typeof Skeleton.computeFK>,
): void {
  const shadowPt = host.asset.attachmentPoints.get('shadow');
  const tex      = getShadowTexture();
  if (!shadowPt) { sprite.visible = false; return; }

  const parent = worldPos.get(shadowPt.parentBone) ?? worldPos.get('root');
  if (!parent) { sprite.visible = false; return; }

  sprite.x        = parent.ex + shadowPt.offsetX;
  sprite.y        = parent.ey + shadowPt.offsetY;
  sprite.rotation = 0;
  sprite.alpha    = 0.55;
  sprite.visible  = true;

  // Use exported shadowW/H; fall back to a reasonable default if missing.
  const sw = shadowPt.shadowW ?? 20;
  const sh = shadowPt.shadowH ?? 6;
  sprite.scale.set(
    (sw * 2) / tex.width,
    (sh * 2) / tex.height,
  );
}
