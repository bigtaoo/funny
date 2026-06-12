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
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Uniform scale applied to the stickman container to fit the game's visual space.
 * The animator works in ~200 px natural height; at 0.27 the character is ~50 px tall.
 */
const STICKMAN_SCALE = 0.27;

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
}

export class StickmanRuntime {
  /** PIXI.Container to add to your scene. Position it at the unit's screen coords. */
  readonly container: PIXI.Container;

  private readonly sprites: Map<string, PIXI.Sprite> = new Map();
  private readonly asset:   TaoAsset;

  private currentClip:     AnimationClip | null = null;
  private currentClipName  = '';
  private time             = 0;

  constructor(asset: TaoAsset, options: StickmanOptions = {}) {
    this.asset     = asset;
    this.container = new PIXI.Container();
    this.container.scale.set(
      STICKMAN_SCALE * (options.mirrorX ? -1 : 1),
      STICKMAN_SCALE,
    );

    // Create one sprite per textured slot, sorted by zOrder (back to front).
    // Shadow (if present) uses zOrder = -Infinity so it always renders below bones.
    const boneIds = [...asset.textures.keys()].sort((a, b) => {
      const za = a === 'shadow' ? -Infinity : (asset.bindings.get(a)?.zOrder ?? 0);
      const zb = b === 'shadow' ? -Infinity : (asset.bindings.get(b)?.zOrder ?? 0);
      return za - zb;
    });

    for (const boneId of boneIds) {
      const tex     = asset.textures.get(boneId)!;
      const binding = asset.bindings.get(boneId);
      const sprite  = new PIXI.Sprite(tex);
      sprite.name   = boneId;
      if (boneId === 'shadow') {
        // Shadow is centred over its attachment position
        sprite.anchor.set(0.5, 0.5);
      } else if (binding) {
        sprite.anchor.set(binding.anchorX, binding.anchorY);
      }
      this.sprites.set(boneId, sprite);
      this.container.addChild(sprite);
    }

    // Start with idle (falls back gracefully if the clip doesn't exist).
    this.play('idle');
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
    this.play(STATE_ANIM[unitState] ?? 'idle');
  }

  /**
   * Reset this runtime for reuse from a pool: re-apply mirror, rewind to idle.
   * Sprites/textures are kept (they all reference the shared asset), so this is
   * far cheaper than constructing a new runtime per spawn — the key win for
   * large swarms where Swordsmen spawn and die continuously.
   */
  reset(options: StickmanOptions = {}): void {
    this.container.scale.set(
      STICKMAN_SCALE * (options.mirrorX ? -1 : 1),
      STICKMAN_SCALE,
    );
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
    const tex      = this.asset.textures.get('shadow');
    if (!shadowPt || !tex) { sprite.visible = false; return; }

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
   */
  static loadAsset(url: string): Promise<TaoAsset> {
    let p = this._cache.get(url);
    if (!p) {
      p = StickmanRuntime._parse(url);
      this._cache.set(url, p);
    }
    return p;
  }

  private static async _parse(url: string): Promise<TaoAsset> {
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
      const { x, y, w, h } = fd.frame;
      textures.set(boneId, new PIXI.Texture(baseTex, new PIXI.Rectangle(x, y, w, h)));
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

    return { clips, textures, bindings, boneLengthScales, attachmentPoints };
  }
}
