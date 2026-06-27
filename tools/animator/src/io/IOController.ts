import * as PIXI from 'pixi.js';
import JSZip from 'jszip';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import { DEFAULT_ZORDER } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type {
  AnimationClip,
  AttachmentPoint,
  BoneKeyframe,
  Keyframe,
  SpriteBinding,
} from '../core/types';

// ── Editor project format (version 1) ────────────────────────────────────────

interface EditorProject {
  version:          1;
  selectedClip:     string | null;
  previewMode:      'skeleton' | 'sprite';
  bindings:         Record<string, SpriteBinding>;
  animations:       Record<string, SerializedClip>;
  attachmentPoints: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;   // per-bone length multipliers; absent = all 1.0
}

// ── Serialization format (version 2) ─────────────────────────────────────────

interface SerializedBoneKeyframe {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  easing?:     string;
}

interface SerializedKeyframe {
  time:  number;
  bones: Record<string, SerializedBoneKeyframe>;
}

interface SerializedClip {
  duration:  number;
  loop:      boolean;
  keyframes: SerializedKeyframe[];
}

interface SerializedProject {
  version:           number;
  bindings:          Record<string, SpriteBinding>;
  animations:        Record<string, SerializedClip>;
  attachmentPoints?: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;
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

// ── IOController ──────────────────────────────────────────────────────────────

export class IOController {
  constructor(
    private readonly state:     AppState,
    private readonly animCtrl:  AnimationController,
    private readonly imageCtrl: ImageController,
    private readonly cmdManager: CommandManager,
    private readonly bus:        EventBus<AppEvents>,
  ) {
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportTao());
    document.getElementById('btn-import')?.addEventListener('click', () => this.triggerImport());
    document.getElementById('file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.importTao(file);
      (e.target as HTMLInputElement).value = '';
    });

    document.getElementById('btn-save-editor')?.addEventListener('click', () => this.saveEditorProject());
    document.getElementById('btn-load-editor')?.addEventListener('click', () => {
      (document.getElementById('editor-file-input') as HTMLInputElement | null)?.click();
    });
    document.getElementById('editor-file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadEditorProject(file);
      (e.target as HTMLInputElement).value = '';
    });
  }

  // ── Editor save / load ────────────────────────────────────────────────────

  /** Build the `.tao.editor` archive (editor.json + per-slot PNGs) as a Blob.
   *  Shared by the manual "Save .editor" button and the IndexedDB auto-save. */
  async buildEditorBlob(): Promise<Blob> {
    const zip = new JSZip();

    // editor.json — all project data + editor state
    const animations: Record<string, SerializedClip> = {};
    this.animCtrl.store.forEach((clip, name) => {
      animations[name] = this.serializeClip(clip);
    });

    const bindings: Record<string, SpriteBinding> = {};
    this.state.boneBindings.forEach((b, id) => { bindings[id] = { ...b }; });

    const attachmentPoints: AttachmentPoint[] = [];
    this.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

    const boneLengthScales: Record<string, number> = {};
    this.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

    const editorJson: EditorProject = {
      version:          1,
      selectedClip:     this.animCtrl.currentName,
      previewMode:      this.state.previewMode,
      bindings,
      animations,
      attachmentPoints,
      ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
    };
    zip.file('editor.json', JSON.stringify(editorJson, null, 2));

    // images/ — one PNG per loaded slot (lossless, no spritesheet packing)
    const imgFolder = zip.folder('images')!;
    for (const slotId of this.state.boneBindings.keys()) {
      const blob = this.imageCtrl.getBlob(slotId);
      if (blob) imgFolder.file(`${slotId}.png`, blob);
    }

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async saveEditorProject(): Promise<void> {
    this.bus.emit('status', 'Saving .tao.editor…');
    try {
      const blob = await this.buildEditorBlob();
      await saveWithPicker(blob, 'project', [
        { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
      ]);
      this.bus.emit('status', 'Project saved');
    } catch (err) {
      this.bus.emit('error', `Save failed: ${(err as Error).message}`);
    }
  }

  loadEditorProject(file: File): Promise<void> {
    return this.loadEditorBlob(file, file.name);
  }

  /** Restore editor state from a `.tao.editor` archive (File or Blob).
   *  Used by both the manual "Load .editor" button and project switching. */
  async loadEditorBlob(data: Blob, label: string): Promise<void> {
    this.bus.emit('status', `Loading ${label}…`);
    try {
      const zip = await JSZip.loadAsync(data);

      const jsonFile = zip.file('editor.json');
      if (!jsonFile) throw new Error('editor.json missing from archive');
      const project = JSON.parse(await jsonFile.async('string')) as EditorProject;

      if (project.version !== 1) {
        this.bus.emit('error', `Unsupported editor version ${project.version}`);
        return;
      }

      // Clear existing state
      this.animCtrl.clearAll();
      [...this.state.boneBindings.keys()].forEach(id => this.state.removeBinding(id));

      // Restore animations + bindings + attachments + rig
      for (const [boneId, binding] of Object.entries(project.bindings)) {
        this.state.setBinding(boneId, binding);
      }
      if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
        this.state.setAllAttachmentPoints(project.attachmentPoints);
      }
      this.state.setAllLengthScales(project.boneLengthScales ?? {});
      for (const [name, clip] of Object.entries(project.animations)) {
        this.animCtrl.loadClip(name, this.deserializeClip(clip));
      }

      // Restore individual images
      const imgFolder = zip.folder('images');
      if (imgFolder) {
        const imagePromises: Promise<void>[] = [];
        imgFolder.forEach((relativePath, zipEntry) => {
          if (zipEntry.dir) return;
          const slotId = relativePath.replace(/\.png$/i, '');
          imagePromises.push(
            zipEntry.async('blob').then(blob => this.imageCtrl.setBlob(slotId, blob, `${slotId}.png`)),
          );
        });
        await Promise.all(imagePromises);
      }

      // Restore editor state
      this.state.setPreviewMode(project.previewMode ?? 'skeleton');
      this.cmdManager.clear();
      this.bus.emit('anim:list');

      const clipToSelect = project.selectedClip ?? [...this.animCtrl.store.keys()][0];
      if (clipToSelect) this.animCtrl.selectClip(clipToSelect);

      this.bus.emit('status', `Loaded ${label}`);
    } catch (err) {
      this.bus.emit('error', `Load failed: ${(err as Error).message}`);
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /** Build the `.tao` runtime bundle (animation.json + optional spritesheet) as a
   *  Blob, WITHOUT triggering a download. Shared by `exportTao()` (download) and the
   *  online workspace (upload) — the CI sync bridge cannot rebuild the spritesheet, so
   *  the browser-built `.tao` must be persisted alongside the `.tao.editor`. */
  async buildTaoBlob(): Promise<Blob> {
    const animJson = this.buildAnimationJson();

    // Bake each image down to the largest size it is ever displayed at (×headroom),
    // capped at the source resolution, then rewrite binding.scaleX/Y to compensate.
    // The game renders sprite.scale = keyframe.scale × binding.scale, so pre-scaling
    // the pixels and dividing binding.scale by the same factor is visually identical
    // while shrinking the spritesheet — no runtime change needed.
    const items = await this.buildExportImages(animJson);

    const zip = new JSZip();
    zip.file('animation.json', JSON.stringify(animJson, null, 2));

    if (items.length > 0) {
      const { canvas, rects } = await this.buildSpritesheet(items);
      const ssJson = this.buildSpritesheetJson(rects, canvas.width, canvas.height);
      const pngBlob = await canvasToBlob(canvas);

      zip.file('spritesheet.json', JSON.stringify(ssJson, null, 2));
      zip.file('spritesheet.png',  pngBlob);
    }

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async exportTao(): Promise<void> {
    this.bus.emit('status', 'Building .tao…');

    try {
      const blob = await this.buildTaoBlob();
      await saveWithPicker(blob, 'animation', [
        { description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } },
      ]);
      this.bus.emit('status', 'Exported .tao');
    } catch (err) {
      this.bus.emit('error', `Export failed: ${(err as Error).message}`);
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  private triggerImport(): void {
    (document.getElementById('file-input') as HTMLInputElement | null)?.click();
  }

  async importTao(file: File): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(file);

      const animFile = zip.file('animation.json');
      if (!animFile) throw new Error('animation.json missing from archive');
      const project = JSON.parse(await animFile.async('string')) as SerializedProject;

      if (project.version !== 2) {
        this.bus.emit('error', `Unsupported version ${project.version} (expected 2)`);
        return;
      }

      // Restore animation data
      this.restoreAnimationData(project);

      // Restore images from spritesheet if present
      const ssJsonFile = zip.file('spritesheet.json');
      const ssPngFile  = zip.file('spritesheet.png');

      if (ssJsonFile && ssPngFile) {
        const ssJson = JSON.parse(await ssJsonFile.async('string')) as SpritesheetJson;
        const ssBlob = await ssPngFile.async('blob');
        await this.restoreImagesFromSpritesheet(ssBlob, ssJson);
      }

      this.cmdManager.clear();
      this.bus.emit('anim:list');
      const first = [...this.animCtrl.store.keys()][0];
      if (first) this.animCtrl.selectClip(first);

      this.bus.emit('status', `Loaded ${file.name}`);
    } catch (err) {
      this.bus.emit('error', `Import failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildAnimationJson(): SerializedProject {
    const bindings: Record<string, SpriteBinding> = {};
    this.state.boneBindings.forEach((b, id) => { bindings[id] = { ...b }; });

    const animations: Record<string, SerializedClip> = {};
    this.animCtrl.store.forEach((clip, name) => {
      animations[name] = this.serializeClip(clip);
    });

    const attachmentPoints: AttachmentPoint[] = [];
    this.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

    const boneLengthScales: Record<string, number> = {};
    this.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

    return {
      version: 2, bindings, animations, attachmentPoints,
      ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
    };
  }

  private restoreAnimationData(project: SerializedProject): void {
    for (const [boneId, binding] of Object.entries(project.bindings)) {
      this.state.setBinding(boneId, binding);
    }
    if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
      this.state.setAllAttachmentPoints(project.attachmentPoints);
    }
    for (const [name, clip] of Object.entries(project.animations)) {
      this.animCtrl.loadClip(name, this.deserializeClip(clip));
    }
  }

  private async restoreImagesFromSpritesheet(
    ssBlob: Blob,
    ssJson: SpritesheetJson,
  ): Promise<void> {
    const img = await loadImageFromBlob(ssBlob);

    for (const [slotId, entry] of Object.entries(ssJson.frames)) {
      const { x, y, w, h } = entry.frame;
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);
      const blob = await canvasToBlob(canvas);
      await this.imageCtrl.setBlob(slotId, blob, slotId);
    }
  }

  // ── Spritesheet building ──────────────────────────────────────────────────

  /** Headroom factor: bake images at 1.5× their largest displayed size so they stay
   *  crisp on high-DPI screens and when an animation scales the bone up past 1.0. */
  private static readonly EXPORT_HEADROOM = 1.5;

  /** Bake each loaded image down to the resolution it actually needs, and rewrite the
   *  corresponding binding.scaleX/Y in `animJson` so the on-screen result is unchanged.
   *  The shadow is not packed — it is drawn procedurally by the runtime from the shadow
   *  attachment point's shadowW/H. */
  private async buildExportImages(
    animJson: SerializedProject,
  ): Promise<Array<{ id: string; src: CanvasImageSource; w: number; h: number }>> {
    const headroom = IOController.EXPORT_HEADROOM;
    const maxKf    = this.computeMaxKeyframeScale();
    const out: Array<{ id: string; src: CanvasImageSource; w: number; h: number }> = [];

    // Shadow is no longer packed: it's a unified soft ellipse the runtime draws
    // procedurally from the shadow attachment point's shadowW/H (see file-formats.md).
    for (const slotId of this.state.boneBindings.keys()) {
      const blob = this.imageCtrl.getBlob(slotId);
      if (!blob) continue;

      const img = await loadImageFromBlob(blob);
      const sw  = img.naturalWidth;
      const sh  = img.naturalHeight;

      let bakeX = 1, bakeY = 1;

      const binding = animJson.bindings[slotId];
      if (binding) {
        const kf = maxKf.get(slotId) ?? { x: 1, y: 1 };
        bakeX = clamp01(Math.abs(binding.scaleX) * kf.x * headroom);
        bakeY = clamp01(Math.abs(binding.scaleY) * kf.y * headroom);
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
  private computeMaxKeyframeScale(): Map<string, { x: number; y: number }> {
    const max = new Map<string, { x: number; y: number }>();
    this.animCtrl.store.forEach(clip => {
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

  private async buildSpritesheet(
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

  private buildSpritesheetJson(
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

  // ── Clip serialization ────────────────────────────────────────────────────

  private serializeClip(clip: AnimationClip): SerializedClip {
    return {
      duration:  clip.duration,
      loop:      clip.loop,
      keyframes: clip.keyframes.map(kf => this.serializeKeyframe(kf)),
    };
  }

  private serializeKeyframe(kf: Keyframe): SerializedKeyframe {
    const bones: Record<string, SerializedBoneKeyframe> = {};
    kf.bones.forEach((bkf, id) => { bones[id] = { ...bkf }; });
    return { time: kf.time, bones };
  }

  private deserializeClip(s: SerializedClip): AnimationClip {
    return {
      duration:  s.duration,
      loop:      s.loop,
      keyframes: s.keyframes.map(kf => this.deserializeKeyframe(kf)),
    };
  }

  private deserializeKeyframe(s: SerializedKeyframe): Keyframe {
    const bones = new Map<string, BoneKeyframe>();
    for (const [id, bkf] of Object.entries(s.bones)) {
      bones.set(id, bkf as BoneKeyframe);
    }
    return { time: s.time, bones };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Clamp a bake factor to (0, 1]: never upscale the source, never produce a zero-size image. */
function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(1, v);
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else   reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** First accepted extension declared in `types` (e.g. ".tao.editor"), or '' if none. */
function primaryExt(types: Array<{ accept: Record<string, string[]> }>): string {
  for (const t of types) {
    for (const exts of Object.values(t.accept)) {
      if (exts[0]) return exts[0];
    }
  }
  return '';
}

/** Guarantee `name` ends with exactly one `ext`. Collapses an accidentally
 *  doubled compound extension (e.g. "x.tao.editor.tao.editor" → "x.tao.editor")
 *  and appends `ext` when missing. This is what prevents the File System Access
 *  picker from re-appending a compound extension (Chrome appends the accepted
 *  extension when the chosen name doesn't already end with it, and historically
 *  double-appends multi-dot extensions like ".tao.editor"). */
function ensureSingleExt(name: string, ext: string): string {
  if (!ext) return name;
  const lower = ext.toLowerCase();
  let n = name;
  while (n.toLowerCase().endsWith(lower + lower)) n = n.slice(0, -ext.length);
  if (!n.toLowerCase().endsWith(lower)) n += ext;
  return n;
}

/** Save blob via the File System Access API (native save dialog with folder + filename).
 *  Falls back to a filename prompt + triggerDownload for browsers without the API (e.g. Firefox). */
async function saveWithPicker(
  blob: Blob,
  suggestedName: string,
  types: Array<{ description?: string; accept: Record<string, string[]> }>,
): Promise<void> {
  // Pass a name that already carries exactly one canonical extension so neither
  // the native picker nor the user prompt can produce a doubled ".tao.editor".
  const ext       = primaryExt(types);
  const suggested = ensureSingleExt(suggestedName, ext);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };
    try {
      handle = await picker({ suggestedName: suggested, types });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;  // user cancelled
      throw e;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } else {
    // Firefox / Safari fallback: prompt for filename, then trigger download.
    // The save path is controlled by the browser's download settings
    // (Firefox: Settings → Downloads → "Always ask you where to save files").
    const name = window.prompt('Save as:', suggested);
    if (name === null) return;  // user cancelled
    triggerDownload(blob, ensureSingleExt(name.trim() || suggested, ext));
  }
}
