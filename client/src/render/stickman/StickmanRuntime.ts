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
import JSZip from 'jszip';
import { sampleClip } from './interpolate';
import { Skeleton } from './skeleton';
import type { AnimationClip, BoneKeyframe, SpriteBinding } from './types';
import { drawEquipmentGlyph } from '../equipmentGlyph';
import type { EquipSlot, EquipRarity } from '../../game/meta/SaveData';

// ── Unified procedural shadow ─────────────────────────────────────────────────
// Shadows are no longer packed per-.tao. A single soft-edged dark ellipse is
// generated once and shared by every rig, scaled to each rig's shadowW/H at
// render time. See claudedocs/file-formats.md (.tao shadow section).
let _shadowTex: PIXI.Texture | null = null;
function getShadowTexture(): PIXI.Texture {
  if (_shadowTex) return _shadowTex;
  const SIZE = 128;
  const canvas  = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const r   = SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,    'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  grad.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  _shadowTex = PIXI.Texture.from(canvas);
  return _shadowTex;
}

// ── TaoAsset (shared, loaded once per .tao file) ──────────────────────────────

/** Parsed attachment point from animation.json (includes optional shadow size). */
export interface TaoAttachmentPoint {
  id:         string;
  parentBone: string;
  offsetX:    number;
  offsetY:    number;
  /** Shadow ellipse half-width in animator pixels. Only present for id === 'shadow'. */
  shadowW?:   number;
  /** Shadow ellipse half-height in animator pixels. Only present for id === 'shadow'. */
  shadowH?:   number;
}

export interface TaoAsset {
  clips:             Map<string, AnimationClip>;
  textures:          Map<string, PIXI.Texture>;          // boneId → sub-texture
  bindings:          Map<string, SpriteBinding>;         // boneId → binding
  boneLengthScales:  Map<string, number>;
  attachmentPoints:  Map<string, TaoAttachmentPoint>;   // id → attachment
  /**
   * Per-bone white outline texture (a detached contour line: the band of pixels
   * just outside the silhouette, RGB forced white so a `tint` recolors it).
   * Generated once at load (cached on the shared asset). Used ONLY for the
   * momentary hit-flash — a brief contour pop on impact — never a constant
   * overlay (a static traced line competes with the hand-drawn ink linework and
   * reads as eye-straining moiré). Empty if generation was skipped (headless).
   */
  outlineTextures:   Map<string, PIXI.Texture>;          // boneId → outline texture
  /** Outline texture anchor (the bordered texture shifts the bone pivot). */
  outlineAnchors:    Map<string, { ax: number; ay: number }>;
  /**
   * Natural bounding-box height (animator px) of the figure — H_nat, the union of
   * FK joint extents over rest pose + all keyframes (see Skeleton.computeNaturalHeight).
   * The per-unit container scale = targetScreenHeight / naturalHeight, which renders
   * every same-tier unit at the same screen height regardless of the artist's canvas
   * size (art-direction §4.5.3 A). 0 when unknown (no clips) → falls back to STICKMAN_SCALE.
   */
  naturalHeight:     number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Fallback uniform scale, used only when a unit's natural height or target height
 * is unknown (no clips / no targetHeight passed). The normal path scales each unit
 * by targetScreenHeight / asset.naturalHeight instead, so same-tier units render at
 * the same screen height regardless of the artist's canvas size (art-direction §4.5.3 A).
 * The animator works in ~200 px natural height; at 0.27 the character is ~50 px tall —
 * which is why the per-tier TARGET_SCREEN_PX values cluster around 0.27 × H_nat.
 */
const STICKMAN_SCALE = 0.27;

/**
 * Hit-flash outline geometry, in *screen* pixels (per-bone radii derive from
 * these so the line reads the same regardless of each bone's baked scale). The
 * outline is a thin *detached* contour: a paper gap separates the body from the
 * line. Slightly bolder than a hairline since it only ever shows for a brief
 * impact flash, where a punchy ring reads best.
 */
const OUTLINE_GAP_PX   = 1.0;   // transparent gap between body edge and the line
const OUTLINE_WIDTH_PX = 2.4;   // thickness of the contour line itself

// ── Equipment overlay (EQUIPMENT_DESIGN §20.4) ─────────────────────────────────
//
// Procedural stationery decals drawn over the figure along the skeleton — the
// battle-render half of "把装备画到角色身上" (§2/§11). Each equipped slot draws the
// same SketchPen glyph used by the UI icons (`equipmentGlyph.ts`), positioned at a
// bone anchor so it rides the animation. Reuses the per-frame FK already computed
// in {@link StickmanRuntime._applyPose} (no extra sampleClip/computeFK on the swarm
// hot path), and shares one tessellated geometry per (slot × rarity) across every
// unit (12 combos total) so a screenful of equipped units costs 12 geometries, not
// 12 × N. PvP never reaches here — equipment is a PvE-only input (A5 hard wall);
// UnitView only calls setGear() for PLAYER_EQUIPPABLE_UNITS in PvE/siege.

/** One equipped slot to overlay on the figure. */
export interface GearGlyphSpec {
  slot:   EquipSlot;
  rarity: EquipRarity;
}

/** Where a slot's glyph rides on the skeleton, in animator-local px. */
interface GearPlacement {
  /** Parent bone whose FK drives the glyph. Falls back to spine→root if missing. */
  bone:   string;
  /** 'tip' = bone end (hand / head); 'mid' = bone midpoint (torso). */
  anchor: 'tip' | 'mid';
  /** Offset from the anchor, animator-local px (un-mirrored; container applies flip). */
  ox:     number;
  oy:     number;
  /** Glyph box edge in animator px (container scale shrinks it to ~¼ on screen). */
  size:   number;
  /** Deterministic pen seed so the scrawl is stable across redraws. */
  seed:   number;
}

/**
 * Default slot → skeleton placement. weapon rides the right (attacking) forearm
 * tip = the drawing hand; armor sits mid-spine = the torso; trinket hangs by the
 * head. Glyphs stay axis-aligned (translate-only) — they read as equipped decals
 * and never look "broken" if a pose swings hard, the conservative choice for a
 * path we can't screenshot-verify. Artist-authored `gear_<slot>` attachment points
 * (if present in the .tao) override `bone`/`ox`/`oy` for fine placement (§20.4).
 */
const GEAR_PLACEMENT: Record<EquipSlot, GearPlacement> = {
  weapon:  { bone: 'r_lower_arm', anchor: 'tip', ox: 0, oy: 0,  size: 42, seed: 7001 },
  armor:   { bone: 'spine',       anchor: 'mid', ox: 0, oy: 2,  size: 52, seed: 7013 },
  trinket: { bone: 'head',        anchor: 'tip', ox: 6, oy: 0,  size: 26, seed: 7027 },
};

/**
 * Shared glyph geometry per `${slot}:${rarity}` (12 combos). The template Graphics
 * is kept alive in the cache so its tessellated geometry survives; per-unit gear
 * sprites are `new PIXI.Graphics(template.geometry)` — geometry is reference-counted,
 * so destroying a unit's gear sprite never disposes the shared template.
 */
const _gearGeomCache = new Map<string, PIXI.Graphics>();

function gearTemplate(slot: EquipSlot, rarity: EquipRarity, size: number, seed: number): PIXI.Graphics {
  const key = `${slot}:${rarity}`;
  let tpl = _gearGeomCache.get(key);
  if (!tpl) {
    tpl = new PIXI.Graphics();
    drawEquipmentGlyph(tpl, slot, rarity, size, seed);
    _gearGeomCache.set(key, tpl);
  }
  return tpl;
}

/** Map logical UnitState values → animation clip names. */
const STATE_ANIM: Record<string, string> = {
  moving:    'walk',
  attacking: 'attack',
  waiting:   'idle',
  crossing:  'walk',
  dead:      'death',
};

// ── StickmanRuntime ───────────────────────────────────────────────────────────

export interface StickmanOptions {
  /** Mirror the character horizontally (for Top-side / enemy units). */
  mirrorX?: boolean;
  /**
   * Target on-screen height (px) for this unit — its size tier's TARGET_SCREEN_PX
   * (see unitSize.ts / art-direction §4.5). The container is scaled by
   * targetHeight / asset.naturalHeight so the figure renders at this height. Omit
   * (or pass 0) to fall back to the flat STICKMAN_SCALE.
   */
  targetHeight?: number;
}

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
    if (asset.attachmentPoints.has('shadow')) {
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
      p = StickmanRuntime._parse(url, targetHeight);
      this._cache.set(url, p);
    }
    return p;
  }

  private static async _parse(url: string, targetHeight?: number): Promise<TaoAsset> {
    // Fetch the .tao ZIP
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`StickmanRuntime: failed to fetch ${url} (${resp.status})`);

    const buf = await resp.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    // ── animation.json ────────────────────────────────────────────────────
    const animRaw = JSON.parse(await zip.file('animation.json')!.async('string')) as any;

    const clips = new Map<string, AnimationClip>();
    for (const [name, raw] of Object.entries(animRaw.animations as Record<string, any>)) {
      clips.set(name, {
        duration:  raw.duration,
        loop:      raw.loop,
        keyframes: (raw.keyframes as any[]).map(kf => ({
          time:  kf.time,
          bones: new Map<string, BoneKeyframe>(
            Object.entries(kf.bones as Record<string, BoneKeyframe>),
          ),
        })),
      });
    }

    const bindings = new Map<string, SpriteBinding>();
    for (const [boneId, b] of Object.entries(animRaw.bindings as Record<string, any>)) {
      bindings.set(boneId, {
        anchorX:  b.anchorX  ?? 0.5,
        anchorY:  b.anchorY  ?? 0.5,
        flipX:    b.flipX    ?? false,
        zOrder:   b.zOrder   ?? 0,
        rotation: b.rotation ?? 0,
        scaleX:   b.scaleX   ?? 1,
        scaleY:   b.scaleY   ?? 1,
        offsetX:  b.offsetX  ?? 0,
        offsetY:  b.offsetY  ?? 0,
      });
    }

    const boneLengthScales = new Map<string, number>();
    if (animRaw.boneLengthScales) {
      for (const [id, s] of Object.entries(animRaw.boneLengthScales as Record<string, number>)) {
        boneLengthScales.set(id, s);
      }
    }

    // H_nat — the figure's natural FK height (animator px), the denominator for the
    // per-unit display scale (art-direction §4.5.3 A). Computed here so it's shared
    // by every instance of this asset; the outline calibration below also needs it.
    const naturalHeight = Skeleton.computeNaturalHeight(clips.values(), boneLengthScales);

    // The scale this rig will actually render at on screen. Used to convert the
    // screen-px outline geometry into texture px (so the hit-flash contour reads the
    // same thickness whatever scale the rig ends up at — and whatever resolution the
    // textures were baked to). Falls back to STICKMAN_SCALE when target/H_nat unknown.
    const parseScale = (targetHeight && naturalHeight > 0)
      ? targetHeight / naturalHeight
      : STICKMAN_SCALE;

    // ── spritesheet ───────────────────────────────────────────────────────
    const spRaw  = JSON.parse(await zip.file('spritesheet.json')!.async('string')) as any;
    const pngBlob = await zip.file('spritesheet.png')!.async('blob');
    const pngUrl  = URL.createObjectURL(pngBlob);

    const baseTex = new PIXI.BaseTexture(pngUrl);
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.on('loaded', resolve);
      baseTex.on('error',  (err: any) => reject(new Error(`Spritesheet load error: ${err}`)));
    });

    const textures = new Map<string, PIXI.Texture>();
    for (const [boneId, fd] of Object.entries(spRaw.frames as Record<string, any>)) {
      // Shadow is drawn procedurally (unified soft ellipse); ignore any packed
      // shadow frame so legacy bundles render the same as freshly-exported ones.
      if (boneId === 'shadow') continue;
      const { x, y, w, h } = fd.frame;
      textures.set(boneId, new PIXI.Texture(baseTex, new PIXI.Rectangle(x, y, w, h)));
    }

    // ── Hit-flash outline textures (white contour, dilated; cached once) ───────
    // Generated from the spritesheet bitmap at load — reused, hidden, shown only
    // during a hit flash. Falls back to no outline if the canvas bitmap can't be
    // read (headless / tainted) — the game still renders fine.
    const outlineTextures = new Map<string, PIXI.Texture>();
    const outlineAnchors  = new Map<string, { ax: number; ay: number }>();
    try {
      const ssImg = await loadImageEl(pngUrl);
      for (const [boneId, fd] of Object.entries(spRaw.frames as Record<string, any>)) {
        if (boneId === 'shadow') continue;
        const { x, y, w, h } = fd.frame;
        const binding = bindings.get(boneId);
        const sScale  = Math.abs(binding?.scaleX ?? 1) || 1;
        // Convert screen-px geometry → this bone's texture px (undo bake + render scale).
        const texPerScreen = 1 / (parseScale * sScale);
        const gapTex   = clampInt(OUTLINE_GAP_PX   * texPerScreen, 1, 14);
        const widthTex = clampInt(OUTLINE_WIDTH_PX * texPerScreen, 1, 10);
        const built    = buildBoneOutline(ssImg, x, y, w, h, gapTex, widthTex, binding);
        if (built) {
          outlineTextures.set(boneId, PIXI.Texture.from(built.canvas));
          outlineAnchors.set(boneId, { ax: built.ax, ay: built.ay });
        }
      }
    } catch (err) {
      console.warn('[StickmanRuntime] outline generation skipped:', err);
    }

    // ── attachment points ────────────────────────────────────────────────────
    const attachmentPoints = new Map<string, TaoAttachmentPoint>();
    for (const ap of (animRaw.attachmentPoints ?? []) as any[]) {
      attachmentPoints.set(ap.id, {
        id:         ap.id,
        parentBone: ap.parentBone ?? 'root',
        offsetX:    ap.offsetX   ?? 0,
        offsetY:    ap.offsetY   ?? 0,
        shadowW:    ap.shadowW,
        shadowH:    ap.shadowH,
      });
    }

    return { clips, textures, bindings, boneLengthScales, attachmentPoints, outlineTextures, outlineAnchors, naturalHeight };
  }
}

// ── Outline generation helpers ─────────────────────────────────────────────────

/** Load an HTMLImageElement from a (same-origin / object) URL. */
function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('outline: spritesheet image load failed'));
    img.src = url;
  });
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Build a white *detached contour line* texture for one bone. The line occupies
 * the band of distance ∈ (gap, gap+width] outside the bone's silhouette — i.e. a
 * `gap`-px transparent margin separates the body from a `width`-px line. Computed
 * as (dilate by gap+width) AND NOT (dilate by gap), each a separable binary
 * box-dilation. RGB is forced white so a per-flash `tint` recolors it.
 *
 * Returns null if the canvas bitmap can't be read (e.g. tainted / headless).
 */
function buildBoneOutline(
  img: HTMLImageElement,
  sx: number, sy: number, w: number, h: number,
  gap: number, width: number,
  binding: SpriteBinding | undefined,
): { canvas: HTMLCanvasElement; ax: number; ay: number } | null {
  const inner = gap;            // dilation radius to the line's inner edge
  const outer = gap + width;    // dilation radius to the line's outer edge
  const B  = outer + 1;         // canvas margin must hold the full outer ring
  const OW = w + 2 * B;
  const OH = h + 2 * B;

  const canvas = document.createElement('canvas');
  canvas.width  = OW;
  canvas.height = OH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(img, sx, sy, w, h, B, B, w, h);

  let srcData: ImageData;
  try {
    srcData = ctx.getImageData(0, 0, OW, OH);
  } catch {
    return null;  // tainted canvas — skip outline, game still renders
  }

  // Binary coverage mask (alpha ≥ 128) of the bordered source.
  const cov = new Uint8Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) cov[i] = srcData.data[i * 4 + 3] >= 128 ? 1 : 0;

  const innerCov = dilateMask(cov, OW, OH, inner);
  const outerCov = dilateMask(cov, OW, OH, outer);

  const out = ctx.createImageData(OW, OH);
  for (let i = 0; i < OW * OH; i++) {
    // The line = covered by the outer dilation but NOT the inner one.
    if (outerCov[i] && !innerCov[i]) {
      const o = i * 4;
      out.data[o] = 255; out.data[o + 1] = 255; out.data[o + 2] = 255; out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  // The bordered texture moves the bone pivot by B px on each axis; re-normalize
  // the binding anchor to the new (OW × OH) texture so the outline aligns exactly.
  const baseAx = binding?.anchorX ?? 0.5;
  const baseAy = binding?.anchorY ?? 0.5;
  return {
    canvas,
    ax: (baseAx * w + B) / OW,
    ay: (baseAy * h + B) / OH,
  };
}

/** Separable binary dilation (box, radius r) of a 0/1 mask. */
function dilateMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      let hit = 0;
      for (let xx = x0; xx <= x1; xx++) { if (src[row + xx]) { hit = 1; break; } }
      horiz[row + x] = hit;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      let hit = 0;
      for (let yy = y0; yy <= y1; yy++) { if (horiz[yy * w + x]) { hit = 1; break; } }
      out[y * w + x] = hit;
    }
  }
  return out;
}
