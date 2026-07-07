/**
 * StickmanRuntime — loads a .tao skeletal animation bundle and drives it
 * frame-by-frame inside a PIXI.Container.
 *
 * Usage:
 *   // App startup — pre-load the shared asset once.
 *   const asset = await StickmanRuntime.loadAsset(infantryTaoUrl);
 *
 *   // Per unit — create runtime instances (cheap, shares textures).
 *   const runtime = new StickmanRuntime(asset, { mirrorX: unit.side === Side.Top });
 *   scene.addChild(runtime.container);
 *
 *   // Each render frame:
 *   runtime.syncState(unit.state);
 *   runtime.update(dt);
 *   runtime.container.position.set(screenX, screenY);
 */

import * as PIXI from 'pixi.js-legacy';
import { sampleClip } from './interpolate';
import { Skeleton } from './skeleton';
import type { AnimationClip } from './types';
import { getShadowTexture } from './shadow';
import { GEAR_PLACEMENT, gearTemplate, type GearPlacement } from './gearOverlay';
import { STICKMAN_SCALE, STATE_ANIM } from './constants';
import { parseTaoAsset } from './assetLoader';
import type { TaoAsset, StickmanOptions, GearGlyphSpec } from './runtimeTypes';

// Re-export the public runtime types so existing importers of
// './StickmanRuntime' keep working unchanged.
export type { TaoAttachmentPoint, TaoAsset, GearGlyphSpec, StickmanOptions } from './runtimeTypes';

export class StickmanRuntime {
  /** PIXI.Container to add to your scene. Position it at the unit's screen coords. */
  readonly container: PIXI.Container;

  private readonly sprites: Map<string, PIXI.Sprite> = new Map();
  /** Hit-flash outline sprites, keyed by boneId (parallel to {@link sprites}). */
  private readonly outlineSprites: Map<string, PIXI.Sprite> = new Map();
  /** Container holding all outline sprites, in front of the bones (the flash pops over the body). */
  private readonly outlineLayer: PIXI.Container;
  /** When false, outline sprites are hidden and not synced (the common case). */
  private outlineFlashing = false;
  /** Equipment overlay glyphs (§20.4), each with its skeleton placement. Empty = no gear. */
  private readonly gearSprites: Array<{ sprite: PIXI.Graphics; placement: GearPlacement }> = [];
  /** Identity of the currently-applied gear, so {@link setGear} is a no-op when unchanged. */
  private gearKey = '';
  /** Container holding the gear decals, between the bones and the hit-flash outline. */
  private readonly gearLayer: PIXI.Container;
  private readonly asset:   TaoAsset;

  /**
   * Unsigned per-unit base scale = targetHeight / asset.naturalHeight (or the flat
   * STICKMAN_SCALE fallback). Applied to the container with the mirror sign on X.
   * Computed once from the constructor options and reused by reset().
   */
  private readonly baseScale: number;

  private currentClip:     AnimationClip | null = null;
  private currentClipName  = '';
  private time             = 0;

  constructor(asset: TaoAsset, options: StickmanOptions = {}) {
    this.asset        = asset;
    this.container    = new PIXI.Container();
    this.gearLayer    = new PIXI.Container();
    this.outlineLayer = new PIXI.Container();
    this.outlineLayer.visible = false;   // shown only during a hit flash

    // Per-unit scale: normalize the rig's natural height to the unit's target
    // screen height (art-direction §4.5.3 A), so same-tier units are the same
    // height on screen regardless of the artist's canvas size. Falls back to the
    // flat STICKMAN_SCALE when either input is missing.
    this.baseScale = (options.targetHeight && asset.naturalHeight > 0)
      ? options.targetHeight / asset.naturalHeight
      : STICKMAN_SCALE;
    this.container.scale.set(
      this.baseScale * (options.mirrorX ? -1 : 1),
      this.baseScale,
    );

    // Unified procedural shadow: a single shared soft ellipse, scaled to this rig's
    // shadowW/H. Added first so it always renders below every bone. No longer packed
    // into the .tao spritesheet — the runtime draws it for any rig with a shadow
    // attachment point, so old bundles (which still carry a shadow frame) get the
    // same treatment once that frame is skipped at load.
    if (options.showShadow !== false && asset.attachmentPoints.has('shadow')) {
      const shadowSprite = new PIXI.Sprite(getShadowTexture());
      shadowSprite.name  = 'shadow';
      shadowSprite.anchor.set(0.5, 0.5);
      this.sprites.set('shadow', shadowSprite);
      this.container.addChild(shadowSprite);
    }

    // Create one sprite per textured slot, sorted by zOrder (back to front).
    const boneIds = [...asset.textures.keys()].sort(
      (a, b) => (asset.bindings.get(a)?.zOrder ?? 0) - (asset.bindings.get(b)?.zOrder ?? 0),
    );

    for (const boneId of boneIds) {
      const tex     = asset.textures.get(boneId)!;
      const binding = asset.bindings.get(boneId);
      const sprite  = new PIXI.Sprite(tex);
      sprite.name   = boneId;
      if (binding) {
        sprite.anchor.set(binding.anchorX, binding.anchorY);
      }
      this.sprites.set(boneId, sprite);
      this.container.addChild(sprite);

      // Matching outline sprite (white, tintable) — hidden until a hit flash.
      const outTex    = asset.outlineTextures.get(boneId);
      const outAnchor = asset.outlineAnchors.get(boneId);
      if (outTex && outAnchor) {
        const outline   = new PIXI.Sprite(outTex);
        outline.name    = boneId;
        outline.anchor.set(outAnchor.ax, outAnchor.ay);
        outline.visible = false;
        this.outlineSprites.set(boneId, outline);
        this.outlineLayer.addChild(outline);
      }
    }
    // Gear decals sit above the bones (an overlay) but below the outline so a hit
    // flash still pops over everything. Empty until setGear() populates it.
    this.container.addChild(this.gearLayer);
    // Outline layer on top so the flash pops over the body silhouette.
    this.container.addChild(this.outlineLayer);

    // Start with idle (falls back gracefully if the clip doesn't exist).
    this.play('idle');
  }

  /**
   * Toggle the momentary hit-flash outline. `color` tints the contour (a hot
   * impact color reads better than white, which is near-invisible over the paper
   * gap); `alpha` fades it out across the flash. `null` clears the flash.
   * Outline transforms are synced in {@link _applyPose} only while flashing, so
   * an idle unit pays nothing for this.
   */
  setOutlineFlash(color: number | null, alpha = 1): void {
    this.outlineFlashing      = color != null;
    this.outlineLayer.visible = this.outlineFlashing;
    if (color != null) {
      for (const o of this.outlineSprites.values()) { o.tint = color; o.alpha = alpha; }
    }
  }

  /**
   * Set the equipment overlay glyphs (§20.4). Builds one gear sprite per slot from
   * the shared (slot × rarity) geometry, placed via {@link GEAR_PLACEMENT} or an
   * artist-authored `gear_<slot>` attachment point when the .tao defines one. Pass
   * `[]` to clear. Idempotent: a no-op when the requested gear matches what's already
   * applied — so UnitView can call it on every (pooled) spawn to reconcile side flips
   * without rebuilding sprites in the common unchanged case.
   */
  setGear(specs: GearGlyphSpec[]): void {
    const key = specs.map(s => `${s.slot}:${s.rarity}`).join(',');
    if (key === this.gearKey) return;
    this.gearKey = key;

    // Tear down any previous glyphs (geometry is shared + ref-counted, so this only
    // drops this unit's reference — the template in the cache survives).
    for (const { sprite } of this.gearSprites) sprite.destroy();
    this.gearSprites.length = 0;

    for (const spec of specs) {
      const base = GEAR_PLACEMENT[spec.slot];
      if (!base) continue;
      const tpl    = gearTemplate(spec.slot, spec.rarity, base.size, base.seed);
      const sprite = new PIXI.Graphics(tpl.geometry);

      // An artist-authored attachment point fine-tunes bone + offset (§20.4).
      const ap = this.asset.attachmentPoints.get(`gear_${spec.slot}`);
      const placement: GearPlacement = ap
        ? { ...base, bone: ap.parentBone, anchor: 'tip', ox: ap.offsetX, oy: ap.offsetY }
        : base;

      this.gearLayer.addChild(sprite);
      this.gearSprites.push({ sprite, placement });
    }
    // Position immediately so a freshly-equipped unit isn't a frame late.
    if (this.gearSprites.length && this.currentClip) this._applyPose();
  }

  /**
   * Recolor every bone sprite to a flat tint — each texture's RGB is multiplied
   * by `color` while its alpha (the silhouette shape) is untouched, so e.g.
   * 0x000000 renders the whole rig as a solid black silhouette. Pass `null` to
   * restore the original multi-color art. Purely decorative (ambient lobby
   * figures); battle rendering never calls this — faction color there comes
   * from {@link drawFactionMarker} instead (art-direction §3.2).
   */
  setSilhouette(color: number | null): void {
    const tint = color ?? 0xffffff;
    for (const s of this.sprites.values()) s.tint = tint;
  }

  /**
   * Union of the *rendered sprite* bounds — the actual drawn pixels — over the
   * rest pose and every keyframe of every clip, in animator-local px (i.e. before
   * the container's own scale/position).
   *
   * This is deliberately NOT asset.naturalHeight: that value measures skeleton
   * *joint* extents, so head/foot/weapon art that overhangs the joints is invisible
   * to it, and it differs from the on-screen silhouette by a per-rig amount. Callers
   * that must size or centre the figure by what the eye actually sees — the
   * decorative lobby silhouette, which fits the figure to a fixed fraction of its
   * button and centres it — use this instead. Unioning over all keyframes gives a
   * pose-stable box on the same basis for every rig, so all rigs come out the same
   * height. Restores the live pose before returning.
   *
   * Excludes the shadow only when the figure was built with showShadow:false (the
   * decorative case); gear/outline layers are empty or hidden so they don't count.
   */
  getRenderedLocalBounds(): { x: number; y: number; width: number; height: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const accumulate = (): void => {
      const b = this.container.getLocalBounds();
      if (b.width <= 0 || b.height <= 0) return;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width  > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    };

    const savedClip = this.currentClip;
    const savedName = this.currentClipName;
    const savedTime = this.time;
    for (const clip of this.asset.clips.values()) {
      this.currentClip = clip;
      for (const kf of clip.keyframes) {
        this.time = kf.time;
        this._applyPose();
        accumulate();
      }
    }
    // Restore the pose that was live before measuring.
    this.currentClip     = savedClip;
    this.currentClipName = savedName;
    this.time            = savedTime;
    if (savedClip) this._applyPose();

    if (!Number.isFinite(minX)) {
      const b = this.container.getLocalBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // ── Animation control ─────────────────────────────────────────────────────

  /** Switch to a named animation clip; resets time to 0 when the clip changes. */
  play(animName: string): void {
    if (animName === this.currentClipName) return;
    const clip = this.asset.clips.get(animName);
    if (!clip) return;
    this.currentClip     = clip;
    this.currentClipName = animName;
    this.time            = 0;
  }

  /** Convenience: map a UnitState string to the appropriate clip and play it. */
  syncState(unitState: string): void {
    const name = STATE_ANIM[unitState] ?? 'idle';
    if (name !== this.currentClipName) {
      this.play(name);
    } else if (this.currentClip && !this.currentClip.loop && this.time >= this.currentClip.duration) {
      // A non-loop clip (e.g. 'attack') has finished but the state still holds —
      // replay it so a unit attacking continuously keeps swinging instead of
      // freezing on the final attack pose.
      this.time = 0;
    }
  }

  /** Duration (seconds) of the currently-playing clip, or 0 when none is set. */
  get currentDuration(): number {
    return this.currentClip?.duration ?? 0;
  }

  /**
   * Reset this runtime for reuse from a pool: re-apply mirror, rewind to idle.
   * Sprites/textures are kept (they all reference the shared asset), so this is
   * far cheaper than constructing a new runtime per spawn — the key win for
   * large swarms where Swordsmen spawn and die continuously.
   */
  reset(options: StickmanOptions = {}): void {
    // baseScale is fixed for this rig (pools are keyed by unit type, so the target
    // height never changes on reuse); only the mirror sign can flip between sides.
    this.container.scale.set(
      this.baseScale * (options.mirrorX ? -1 : 1),
      this.baseScale,
    );
    this.setOutlineFlash(null);   // a reused runtime must not carry a stale flash
    // Gear glyphs are left in place here; UnitView re-asserts the correct gear on each
    // (pooled) spawn via the idempotent setGear() — a no-op unless the unit's side or
    // loadout changed, so the pooling win is kept while side flips reconcile (§20.4).
    this.currentClip     = null;
    this.currentClipName = '';
    this.time            = 0;
    this.play('idle');
  }

  /**
   * Advance the animation clock and re-render sprites.
   * Call once per render frame with the elapsed wall-clock delta (seconds).
   */
  update(dt: number): void {
    if (!this.currentClip) return;

    this.time += dt;
    if (this.currentClip.loop) {
      const dur = this.currentClip.duration;
      if (dur > 0) this.time = this.time % dur;
    } else {
      this.time = Math.min(this.time, this.currentClip.duration);
    }

    this._applyPose();
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  /**
   * Screen-space offset of an attachment point (e.g. 'hit') relative to this
   * runtime's container origin — i.e. already scaled by STICKMAN_SCALE and
   * mirrored to match the rendered sprites. Add it to the unit's screen position
   * to place a hit spark on the torso instead of the grid-cell centre.
   * Returns null if the attachment point or current pose is unavailable.
   */
  /**
   * Ground anchor of the shadow: screen-space offset from the container origin
   * (already scaled + mirrored) plus the shadow ellipse half-extents in screen
   * px. Used to place the faction ground marker exactly over the shadow rather
   * than at a guessed Y. Null if the .tao has no shadow or no current clip.
   */
  getShadowGround(): { x: number; y: number; rx: number; ry: number } | null {
    const pt = this.asset.attachmentPoints.get('shadow');
    if (!pt || !this.currentClip) return null;
    const transforms = sampleClip(this.currentClip, this.time);
    const worldPos   = Skeleton.computeFK(0, 0, transforms, this.asset.boneLengthScales);
    const parent     = worldPos.get(pt.parentBone) ?? worldPos.get('root');
    if (!parent) return null;
    const sx = this.container.scale.x;   // signed (negative when mirrored)
    const sy = this.container.scale.y;
    return {
      x:  (parent.ex + pt.offsetX) * sx,
      y:  (parent.ey + pt.offsetY) * sy,
      rx: (pt.shadowW ?? 20) * Math.abs(sx),
      ry: (pt.shadowH ?? 6)  * sy,
    };
  }

  getAttachmentOffset(id: string): { x: number; y: number } | null {
    const pt = this.asset.attachmentPoints.get(id);
    if (!pt || !this.currentClip) return null;

    const transforms = sampleClip(this.currentClip, this.time);
    const worldPos   = Skeleton.computeFK(0, 0, transforms, this.asset.boneLengthScales);
    const parent     = worldPos.get(pt.parentBone) ?? worldPos.get('root');
    if (!parent) return null;

    return {
      x: (parent.ex + pt.offsetX) * this.container.scale.x,
      y: (parent.ey + pt.offsetY) * this.container.scale.y,
    };
  }

  // ── Pose evaluation ───────────────────────────────────────────────────────

  private _applyPose(): void {
    if (!this.currentClip) return;

    const transforms = sampleClip(this.currentClip, this.time);
    const worldPos   = Skeleton.computeFK(0, 0, transforms, this.asset.boneLengthScales);

    for (const [boneId, sprite] of this.sprites) {
      // ── Shadow attachment point — special rendering ───────────────────────
      if (boneId === 'shadow') {
        this._applyShadowPose(sprite, worldPos);
        continue;
      }

      // ── Normal bone sprite — composite formula (matches animator Renderer.ts)
      //   sprite.x        = bone_pivot.x + kf.translateX + binding.offsetX
      //   sprite.y        = bone_pivot.y + kf.translateY + binding.offsetY
      //   sprite.rotation = (bone_wa + kf.rotation + binding.rotation) * PI/180
      //   sprite.scale    = kf.scale × binding.scale  (× -1 for flipX)
      const pose    = worldPos.get(boneId);
      const binding = this.asset.bindings.get(boneId);
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
      if (this.outlineFlashing) {
        const outline = this.outlineSprites.get(boneId);
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
    for (const { sprite, placement } of this.gearSprites) {
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
  private _applyShadowPose(
    sprite:   PIXI.Sprite,
    worldPos: ReturnType<typeof Skeleton.computeFK>,
  ): void {
    const shadowPt = this.asset.attachmentPoints.get('shadow');
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

  // ── Static asset loading (cached) ─────────────────────────────────────────

  private static readonly _cache = new Map<string, Promise<TaoAsset>>();

  /**
   * Load and parse a .tao bundle from `url`.
   * Results are cached by URL — subsequent calls return the same Promise.
   *
   * `targetHeight` (the unit tier's TARGET_SCREEN_PX) is used only to calibrate the
   * shared hit-flash outline texture to the scale this rig will actually render at
   * (a .tao url maps to one unit type → one target, so the cached outline is correct).
   * The per-unit display scale itself is applied per instance from StickmanOptions.
   */
  static loadAsset(url: string, targetHeight?: number): Promise<TaoAsset> {
    let p = this._cache.get(url);
    if (!p) {
      p = parseTaoAsset(url, targetHeight);
      this._cache.set(url, p);
    }
    return p;
  }
}
