// IOController's `.tao` runtime-bundle export flow, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). taoFileHandle is a getter/setter pair
// (not a plain property) because exportTao reassigns it wholesale on the first export of a
// session (same reasoning as editorProject.ts's EditorProjectHost); editorFilePath/
// editorFileHandle are read-only getters — this flow only ever reads them.
import JSZip from 'jszip';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AttachmentPoint, SpriteBinding } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';
import { TARGET_SCREEN_PX, SUPERSAMPLE, type SizeTierKey } from './unitSize';
import { basename, canvasToBlob, clamp01, deriveTaoPath, isDesktop, loadImageFromBlob, saveWithPicker, type WritableFileHandle } from './fileIO';
import { serializeClip, type SerializedClip } from './clipSerialization';
import { serializeBindings } from './bindingSerialization';

// ── Serialization format (version 2) ─────────────────────────────────────────

interface SerializedProject {
  version:           number;
  bindings:          Record<string, SpriteBinding>;
  animations:        Record<string, SerializedClip>;
  attachmentPoints?: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;
  /**
   * Size-tier the textures were baked for (art-direction §4.5.3 B). Informational /
   * self-documenting — the runtime sizes units from its own unitSize.ts by UnitType,
   * not from this block. `naturalHeight` is H_nat (animator px) at export time.
   * Absent in pre-§4.5 bundles. See claudedocs/file-formats.md.
   */
  unitHeight?: {
    tier:           SizeTierKey;
    targetScreenPx: number;
    naturalHeight:  number;
    supersample:    number;
  };
}

// ── Spritesheet types ─────────────────────────────────────────────────────────

interface SpritesheetFrame {
  frame:      { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

interface SpritesheetJson {
  frames: Record<string, SpritesheetFrame>;
  meta:   { size: { w: number; h: number } };
}

export interface TaoExportHost {
  readonly state:             AppState;
  readonly animCtrl:          AnimationController;
  readonly imageCtrl:         ImageController;
  readonly bus:               EventBus<AppEvents>;
  readonly editorFilePath:    string | null;
  readonly editorFileHandle:  WritableFileHandle | null;
  taoFileHandle:              WritableFileHandle | null;
}

/** Fallback bake headroom, used only when H_nat is unknown (no clips → can't anchor
 *  to an absolute target). Bakes at 1.5× the largest displayed size for DPI/animation
 *  headroom — the legacy behaviour before per-tier absolute baking (§4.5.3 B). */
const EXPORT_HEADROOM = 1.5;

/** Build the `.tao` runtime bundle (animation.json + optional spritesheet) as a
 *  Blob, WITHOUT triggering a download. Used by `exportTao()` before writing it
 *  to disk. */
export async function buildTaoBlob(host: TaoExportHost): Promise<Blob> {
  // Size tier (export panel) + the rig's natural FK height drive the bake-down to an
  // absolute target resolution rather than the artist's canvas size (§4.5.3 B).
  const tier = readExportTier();
  const hNat = computeNaturalHeight(host);
  const animJson = buildAnimationJson(host, tier, hNat);

  // Bake each image down to the resolution it is actually displayed at (target
  // screen height × supersample), then rewrite binding.scaleX/Y to compensate.
  // The game renders sprite.scale = keyframe.scale × binding.scale, so pre-scaling
  // the pixels and dividing binding.scale by the same factor is visually identical
  // while shrinking the spritesheet — no runtime change needed.
  const items = await buildExportImages(host, animJson, tier, hNat);

  const zip = new JSZip();
  zip.file('animation.json', JSON.stringify(animJson, null, 2));

  if (items.length > 0) {
    const { canvas, rects } = await buildSpritesheet(items);
    const ssJson = buildSpritesheetJson(rects, canvas.width, canvas.height);
    const pngBlob = await canvasToBlob(canvas);

    zip.file('spritesheet.json', JSON.stringify(ssJson, null, 2));
    zip.file('spritesheet.png',  pngBlob);
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Writes the `.tao` bundle next to the loaded `.taoeditor` (desktop: derived same-
 *  directory path written directly; browser: remembered handle reused) so repeat
 *  exports never re-prompt. Only asks for a location when there's nothing to anchor to
 *  yet (no project loaded/saved this session). */
export async function exportTao(host: TaoExportHost): Promise<void> {
  host.bus.emit('status', 'Building .tao…');

  try {
    const blob = await buildTaoBlob(host);

    if (isDesktop()) {
      const fsApi = window.nwDesktop!.fs;
      const buf = await blob.arrayBuffer();
      const derivedPath = host.editorFilePath ? deriveTaoPath(host.editorFilePath) : null;
      if (derivedPath) {
        const result = await fsApi.writeFile(derivedPath, buf);
        if (!result.ok) throw new Error(result.error ?? 'write failed');
        host.bus.emit('status', `Exported ${basename(derivedPath)}`);
        return;
      }
      const result = await fsApi.saveFileAs({ filters: [{ name: 'Tao Animation', extensions: ['tao'] }] }, buf);
      if (result.canceled) return;
      if (result.error || !result.path) throw new Error(result.error ?? 'save failed');
      host.bus.emit('status', `Exported ${basename(result.path)}`);
      return;
    }

    if (host.taoFileHandle) {
      const writable = await host.taoFileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      host.taoFileHandle = await saveWithPicker(blob, 'animation', [
        { description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } },
      ], host.editorFileHandle);
    }
    host.bus.emit('status', 'Exported .tao');
  } catch (err) {
    host.bus.emit('error', `Export failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildAnimationJson(host: TaoExportHost, tier: SizeTierKey, hNat: number): SerializedProject {
  const bindings = serializeBindings(host.state.boneBindings);

  const animations: Record<string, SerializedClip> = {};
  host.animCtrl.store.forEach((clip, name) => {
    animations[name] = serializeClip(clip);
  });

  const attachmentPoints: AttachmentPoint[] = [];
  host.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

  const boneLengthScales: Record<string, number> = {};
  host.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

  return {
    version: 2, bindings, animations, attachmentPoints,
    ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
    unitHeight: {
      tier,
      targetScreenPx: TARGET_SCREEN_PX[tier],
      naturalHeight:  Math.round(hNat),
      supersample:    SUPERSAMPLE,
    },
  };
}

/** Selected export size tier (export panel dropdown), default M. */
function readExportTier(): SizeTierKey {
  const sel = document.getElementById('sel-export-tier') as HTMLSelectElement | null;
  const v = sel?.value as SizeTierKey | undefined;
  return (v === 'S' || v === 'M' || v === 'L' || v === 'XL') ? v : 'M';
}

/** H_nat — the rig's natural FK height (animator px) over rest pose + all keyframes. */
function computeNaturalHeight(host: TaoExportHost): number {
  return Skeleton.computeNaturalHeight(host.animCtrl.store.values(), host.state.boneLengthScales);
}

// ── Spritesheet building ──────────────────────────────────────────────────

/** Bake each loaded image down to the resolution it actually needs, and rewrite the
 *  corresponding binding.scaleX/Y in `animJson` so the on-screen result is unchanged.
 *  The shadow is not packed — it is drawn procedurally by the runtime from the shadow
 *  attachment point's shadowW/H.
 *
 *  §4.5.3 B: the bake is anchored to the ABSOLUTE target display size, not the
 *  artist's canvas. Global factor G = SUPERSAMPLE × TARGET_SCREEN_PX[tier] / H_nat,
 *  which folds in BOTH (1) the unit's real on-screen height and (2) the supersample
 *  headroom that replaces the old guessed 1.5 — so the figure's baked texture
 *  footprint becomes exactly TARGET_SCREEN_PX × SUPERSAMPLE px. Per-bone we still
 *  multiply by |binding.scaleX| × max-keyframe-scale (a bone shown small / scaled up
 *  needs proportionally fewer / more texels), then compensate binding.scaleX /= bake
 *  so the runtime render is pixel-identical. (Uses SCREEN px, not authoring px: the
 *  runtime scales the rig to TARGET_SCREEN_PX, so anchoring the texture to the same
 *  number is what makes ~SUPERSAMPLE texels land per screen px — anchoring to the
 *  ~3.7× larger authoring px would re-introduce the very oversampling we're removing.) */
async function buildExportImages(
  host: TaoExportHost,
  animJson: SerializedProject,
  tier: SizeTierKey,
  hNat: number,
): Promise<Array<{ id: string; src: CanvasImageSource; w: number; h: number }>> {
  // G replaces the old flat headroom: absolute target resolution per tier.
  const G = hNat > 0
    ? (SUPERSAMPLE * TARGET_SCREEN_PX[tier]) / hNat
    : EXPORT_HEADROOM;
  const maxKf = computeMaxKeyframeScale(host);
  const out: Array<{ id: string; src: CanvasImageSource; w: number; h: number }> = [];

  // Shadow is no longer packed: it's a unified soft ellipse the runtime draws
  // procedurally from the shadow attachment point's shadowW/H (see file-formats.md).
  for (const slotId of host.state.boneBindings.keys()) {
    const blob = host.imageCtrl.getBlob(slotId);
    if (!blob) continue;

    const img = await loadImageFromBlob(blob);
    const sw  = img.naturalWidth;
    const sh  = img.naturalHeight;

    let bakeX = 1, bakeY = 1;

    const binding = animJson.bindings[slotId];
    if (binding) {
      const kf = maxKf.get(slotId) ?? { x: 1, y: 1 };
      bakeX = clamp01(Math.abs(binding.scaleX) * kf.x * G);
      bakeY = clamp01(Math.abs(binding.scaleY) * kf.y * G);
      // Compensate so keyframe.scale × binding.scale renders identical pixels.
      binding.scaleX /= bakeX;
      binding.scaleY /= bakeY;
    }

    if (bakeX > 0.999 && bakeY > 0.999) {
      out.push({ id: slotId, src: img, w: sw, h: sh });
    } else {
      const dw     = Math.max(1, Math.round(sw * bakeX));
      const dh     = Math.max(1, Math.round(sh * bakeY));
      const canvas = document.createElement('canvas');
      canvas.width  = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, dw, dh);
      out.push({ id: slotId, src: canvas, w: dw, h: dh });
    }
  }

  return out;
}

/** Largest per-axis keyframe scale each bone reaches across all clips (default 1). */
function computeMaxKeyframeScale(host: TaoExportHost): Map<string, { x: number; y: number }> {
  const max = new Map<string, { x: number; y: number }>();
  host.animCtrl.store.forEach(clip => {
    for (const kf of clip.keyframes) {
      kf.bones.forEach((bkf, boneId) => {
        const cur = max.get(boneId) ?? { x: 1, y: 1 };
        cur.x = Math.max(cur.x, Math.abs(bkf.scaleX ?? 1));
        cur.y = Math.max(cur.y, Math.abs(bkf.scaleY ?? 1));
        max.set(boneId, cur);
      });
    }
  });
  return max;
}

async function buildSpritesheet(
  loaded: Array<{ id: string; src: CanvasImageSource; w: number; h: number }>,
): Promise<{ canvas: HTMLCanvasElement; rects: Map<string, { x: number; y: number; w: number; h: number }> }> {
  // Simple shelf-packing (sort by height descending for better fill)
  const PADDING  = 2;
  const MAX_W    = 1024;
  const sorted   = [...loaded].sort((a, b) => b.h - a.h);
  const rects    = new Map<string, { x: number; y: number; w: number; h: number }>();
  let curX = 0, curY = 0, rowH = 0;

  for (const item of sorted) {
    if (curX + item.w > MAX_W && curX > 0) {
      curX = 0;
      curY += rowH + PADDING;
      rowH  = 0;
    }
    rects.set(item.id, { x: curX, y: curY, w: item.w, h: item.h });
    curX += item.w + PADDING;
    rowH  = Math.max(rowH, item.h);
  }

  const totalH = curY + rowH;
  const canvas = document.createElement('canvas');
  canvas.width  = MAX_W;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d')!;

  for (const item of loaded) {
    const r = rects.get(item.id)!;
    ctx.drawImage(item.src, r.x, r.y);
  }

  return { canvas, rects };
}

function buildSpritesheetJson(
  rects: Map<string, { x: number; y: number; w: number; h: number }>,
  totalW: number,
  totalH: number,
): SpritesheetJson {
  const frames: Record<string, SpritesheetFrame> = {};
  rects.forEach((r, id) => {
    frames[id] = { frame: { ...r }, sourceSize: { w: r.w, h: r.h } };
  });
  return { frames, meta: { size: { w: totalW, h: totalH } } };
}
