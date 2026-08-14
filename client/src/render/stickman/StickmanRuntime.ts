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
import { applyPose } from './pose';

// Re-export the public runtime types so existing importers of
// './StickmanRuntime' keep working unchanged.
export type { TaoAttachmentPoint, TaoAsset, GearGlyphSpec, StickmanOptions } from './runtimeTypes';

export class StickmanRuntime {
  /** PIXI.Container to add to your scene. Position it at the unit's screen coords. */
  readonly container: PIXI.Container;

  // The 7 fields below are `public` (not `private`) so render/stickman/pose.ts's applyPose() can
  // read them through its narrow `PoseHost` interface — a private field can't satisfy an external
  // module's structural interface (same visibility bump every mixin→composition/form① conversion
  // in this codebase has needed). They're still internal-only in practice: nothing outside
  // StickmanRuntime and pose.ts has any reason to touch them.
  readonly sprites: Map<string, PIXI.Sprite> = new Map();
  /** Hit-flash outline sprites, keyed by boneId (parallel to {@link sprites}). */
  readonly outlineSprites: Map<string, PIXI.Sprite> = new Map();
  /** Container holding all outline sprites, in front of the bones (the flash pops over the body). */
  private readonly outlineLayer: PIXI.Container;
  /** When false, outline sprites are hidden and not synced (the common case). */
  outlineFlashing = false;
  /** Equipment overlay glyphs (§20.4), each with its skeleton placement. Empty = no gear. */
  readonly gearSprites: Array<{ sprite: PIXI.Graphics; placement: GearPlacement }> = [];
  /** Identity of the currently-applied gear, so {@link setGear} is a no-op when unchanged. */
  private gearKey = '';
  /** Container holding the gear decals, between the bones and the hit-flash outline. */
  private readonly gearLayer: PIXI.Container;
  readonly asset:   TaoAsset;

  /**
   * Unsigned per-unit base scale = targetHeight / asset.naturalHeight (or the flat
   * STICKMAN_SCALE fallback). Applied to the container with the mirror sign on X.
   * Computed once from the constructor options and reused by reset().
   */
  private readonly baseScale: number;

  currentClip:     AnimationClip | null = null;
  private currentClipName  = '';
  time             = 0;
  /** See {@link setAttackInterval}. */
  private attackIntervalSec = 0;

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
   * Outline transforms are synced in {@link applyPose} only while flashing, so
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
    if (this.gearSprites.length && this.currentClip) applyPose(this);
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
        applyPose(this);
        accumulate();
      }
    }
    // Restore the pose that was live before measuring.
    this.currentClip     = savedClip;
    this.currentClipName = savedName;
    this.time            = savedTime;
    if (savedClip) applyPose(this);

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
      // freezing on the final attack pose. With attackIntervalSec set (see
      // setAttackInterval()) each playthrough already takes exactly one real
      // attack interval of wall-clock time, so this loop point lines up with
      // the unit's actual next attack.
      this.time = 0;
    }
  }

  /**
   * Seconds the unit's real attack cycle takes (its effective attack interval),
   * or 0 to play the clip at its own authored duration. Set from the unit's
   * live combat stats (`UnitView.sync`) so the 'attack' clip is time-scaled to
   * finish exactly one playthrough per real attack, instead of looping at a
   * fixed authored duration that has no relation to how often the unit
   * actually swings (see update()).
   */
  setAttackInterval(seconds: number): void {
    this.attackIntervalSec = seconds;
  }

  /** Duration (seconds) of the currently-playing clip, or 0 when none is set. */
  get currentDuration(): number {
    return this.currentClip?.duration ?? 0;
  }

  /** Elapsed time (seconds) into the currently-playing clip. */
  get currentTime(): number {
    return this.time;
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

    // Stretch/compress the 'attack' clip so one playthrough takes exactly the
    // unit's real attack interval, e.g. a 1 s attack interval plays the swing
    // over 1 s regardless of the art's authored clip duration. Other clips
    // (walk/idle/death) are unaffected — they have no real-world cadence to match.
    let rate = 1;
    if (this.currentClipName === 'attack' && this.attackIntervalSec > 0 && this.currentClip.duration > 0) {
      rate = this.currentClip.duration / this.attackIntervalSec;
    }
    this.time += dt * rate;
    if (this.currentClip.loop) {
      const dur = this.currentClip.duration;
      if (dur > 0) this.time = this.time % dur;
    } else {
      this.time = Math.min(this.time, this.currentClip.duration);
    }

    applyPose(this);
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

  // ── Pose evaluation — see render/stickman/pose.ts's applyPose() ────────────

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
      p = parseTaoAsset(url, targetHeight).catch((e) => {
        // Reset the cache entry so a later loadAsset(url) call (e.g. after a network blip clears
        // up) retries instead of replaying this same rejection forever (audit 2026-07-29: a
        // transient failure used to permanently negative-cache a unit's rig — including L0 boot
        // units like infantry/archer/shieldbearer — for the rest of the session, stuck showing a
        // placeholder circle even once the network recovers).
        this._cache.delete(url);
        throw e;
      });
      this._cache.set(url, p);
    }
    return p;
  }
}
