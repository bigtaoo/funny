// ── .tao asset loading & parsing ──────────────────────────────────────────────
// Fetches and parses a .tao ZIP bundle into a shared TaoAsset (clips, textures,
// bindings, attachment points, and the hit-flash outline cache). Standalone from
// StickmanRuntime — the static loadAsset() cache delegates here.

import * as PIXI from 'pixi.js-legacy';
import JSZip from 'jszip';
import { Skeleton } from './skeleton';
import type { AnimationClip, BoneKeyframe, SpriteBinding } from './types';
import type { TaoAsset, TaoAttachmentPoint } from './runtimeTypes';
import { STICKMAN_SCALE, OUTLINE_GAP_PX, OUTLINE_WIDTH_PX } from './constants';
import { loadImageEl, clampInt, buildBoneOutline } from './outline';
import { assetIO } from '../../assets/assetIO';

export async function parseTaoAsset(url: string, targetHeight?: number): Promise<TaoAsset> {
  // Fetch the .tao ZIP bytes via the platform AssetIO (Web: fetch; WeChat: CDN +
  // local cache — ASSET_PACKAGING §4.1).
  const buf = await assetIO().loadBinary(url);
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
    baseTex.once('loaded', resolve);
    baseTex.once('error',  (err: any) => reject(new Error(`Spritesheet load error: ${err}`)));
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
    URL.revokeObjectURL(pngUrl);
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
    URL.revokeObjectURL(pngUrl);
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
