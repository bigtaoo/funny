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
  /**
   * Per-bone white outline texture (silhouette dilated outward by a few px, RGB
   * forced white so a per-unit `tint` recolors it to the faction ink). Generated
   * once at load (cached on the shared asset), driven at runtime by a 1-sprite-
   * per-bone back layer — the cheap, device-friendly alternative to a per-unit
   * outline filter. Shadow has no outline. Empty if generation was skipped.
   */
  outlineTextures:   Map<string, PIXI.Texture>;          // boneId → outline texture
  /** Outline texture anchor (the bordered texture shifts the bone pivot). */
  outlineAnchors:    Map<string, { ax: number; ay: number }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Uniform scale applied to the stickman container to fit the game's visual space.
 * The animator works in ~200 px natural height; at 0.27 the character is ~50 px tall.
 */
const STICKMAN_SCALE = 0.27;

/**
 * Faction outline geometry, in *screen* pixels (per-bone radii are derived from
 * these so the line reads the same regardless of each bone's baked texture scale).
 * The outline is a thin *detached* contour line, not a solid silhouette: a paper-
 * colored GAP separates the body from the LINE, so it reads as a drawn outline
 * around the character rather than a hugging colored garment.
 */
const OUTLINE_GAP_PX   = 1.6;   // transparent gap between body edge and the line
const OUTLINE_WIDTH_PX = 1.2;   // thickness of the contour line itself

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
   * Faction outline tint (e.g. theme.factionInk.friend / .enemy). When set, a
   * white outline layer renders behind the bones tinted to this color — the
   * friend/foe signal for full-color art sprites. `null` / omitted = no outline.
   */
  outlineColor?: number | null;
}

export class StickmanRuntime {
  /** PIXI.Container to add to your scene. Position it at the unit's screen coords. */
  readonly container: PIXI.Container;

  private readonly sprites: Map<string, PIXI.Sprite> = new Map();
  /** Outline back-layer sprites, keyed by boneId (parallel to {@link sprites}). */
  private readonly outlineSprites: Map<string, PIXI.Sprite> = new Map();
  /** Container holding all outline sprites, below the real bones, above the shadow. */
  private readonly outlineLayer: PIXI.Container;
  /** Current faction outline tint, or null when no outline is shown. */
  private outlineColor: number | null;
  private readonly asset:   TaoAsset;

  private currentClip:     AnimationClip | null = null;
  private currentClipName  = '';
  private time             = 0;

  constructor(asset: TaoAsset, options: StickmanOptions = {}) {
    this.asset        = asset;
    this.outlineColor = options.outlineColor ?? null;
    this.container    = new PIXI.Container();
    this.outlineLayer = new PIXI.Container();
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

    // Layering: [shadow] → [outline layer] → [bone sprites]. A single back layer
    // for all outlines (rather than one behind each bone) makes overlapping limbs
    // read as one "paper cut-out" silhouette — inner seams hide behind front parts.
    let outlineLayerAdded = false;
    for (const boneId of boneIds) {
      const tex     = asset.textures.get(boneId)!;
      const binding = asset.bindings.get(boneId);
      const sprite  = new PIXI.Sprite(tex);
      sprite.name   = boneId;
      if (boneId === 'shadow') {
        // Shadow is centred over its attachment position, stays below the outline.
        sprite.anchor.set(0.5, 0.5);
        this.sprites.set(boneId, sprite);
        this.container.addChild(sprite);
        continue;
      }

      if (!outlineLayerAdded) {
        this.container.addChild(this.outlineLayer);
        outlineLayerAdded = true;
      }

      if (binding) sprite.anchor.set(binding.anchorX, binding.anchorY);
      this.sprites.set(boneId, sprite);
      this.container.addChild(sprite);

      // Matching outline sprite (white texture, tinted to faction ink).
      const outTex    = asset.outlineTextures.get(boneId);
      const outAnchor = asset.outlineAnchors.get(boneId);
      if (outTex && outAnchor) {
        const outline = new PIXI.Sprite(outTex);
        outline.name = boneId;
        outline.anchor.set(outAnchor.ax, outAnchor.ay);
        outline.tint    = this.outlineColor ?? 0xffffff;
        outline.visible = this.outlineColor != null;
        this.outlineSprites.set(boneId, outline);
        this.outlineLayer.addChild(outline);
      }
    }
    if (!outlineLayerAdded) this.container.addChild(this.outlineLayer);

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
    // Re-apply faction tint: a pooled runtime may be reused for the opposite side.
    if (options.outlineColor !== undefined) {
      this.outlineColor = options.outlineColor;
      for (const outline of this.outlineSprites.values()) {
        outline.tint    = this.outlineColor ?? 0xffffff;
        outline.visible = this.outlineColor != null;
      }
    }
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

      // Outline sprite shares the bone's pivot/transform; its own (bordered)
      // anchor was pre-computed so identical x/y/rotation/scale align them.
      const outline = this.outlineSprites.get(boneId);
      if (outline) {
        outline.x        = sprite.x;
        outline.y        = sprite.y;
        outline.rotation = sprite.rotation;
        outline.scale.set(sprite.scale.x, sprite.scale.y);
        outline.alpha    = alpha;
        outline.visible  = this.outlineColor != null && alpha > 0;
      }
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

    // ── Faction outline textures (white silhouette, dilated; cached once) ──────
    // Generated from the spritesheet bitmap at load — one extra static sprite per
    // bone at runtime, no per-unit filter. Falls back to no outline if the canvas
    // bitmap can't be read (headless / tainted) — the game still renders fine.
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
        const texPerScreen = 1 / (STICKMAN_SCALE * sScale);
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

    return { clips, textures, bindings, boneLengthScales, attachmentPoints, outlineTextures, outlineAnchors };
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
 * `gap`-px transparent margin separates the body from a `width`-px line, so it
 * reads as a drawn outline around the character, not a hugging colored garment.
 * Computed as (dilate by gap+width) AND NOT (dilate by gap), each a separable
 * binary box-dilation. RGB is forced white so a per-unit `tint` recolors it.
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
