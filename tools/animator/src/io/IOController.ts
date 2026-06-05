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

  async saveEditorProject(): Promise<void> {
    this.bus.emit('status', 'Saving .tao.editor…');
    try {
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
      const allSlots = [...this.state.boneBindings.keys(), 'shadow'];
      for (const slotId of allSlots) {
        const blob = this.imageCtrl.getBlob(slotId);
        if (blob) imgFolder.file(`${slotId}.png`, blob);
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      await saveWithPicker(blob, 'project', [
        { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
      ]);
      this.bus.emit('status', 'Project saved');
    } catch (err) {
      this.bus.emit('status', `Save failed: ${(err as Error).message}`);
    }
  }

  async loadEditorProject(file: File): Promise<void> {
    this.bus.emit('status', `Loading ${file.name}…`);
    try {
      const zip = await JSZip.loadAsync(file);

      const jsonFile = zip.file('editor.json');
      if (!jsonFile) throw new Error('editor.json missing from archive');
      const project = JSON.parse(await jsonFile.async('string')) as EditorProject;

      if (project.version !== 1) {
        this.bus.emit('status', `Unsupported editor version ${project.version}`);
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

      this.bus.emit('status', `Loaded ${file.name}`);
    } catch (err) {
      this.bus.emit('status', `Load failed: ${(err as Error).message}`);
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async exportTao(): Promise<void> {
    this.bus.emit('status', 'Building .tao…');

    try {
      const animJson = this.buildAnimationJson();

      // Collect image blobs
      const items: Array<{ id: string; blob: Blob }> = [];
      for (const slotId of [...this.state.boneBindings.keys(), 'shadow']) {
        const blob = this.imageCtrl.getBlob(slotId);
        if (blob) items.push({ id: slotId, blob });
      }

      const zip = new JSZip();
      zip.file('animation.json', JSON.stringify(animJson, null, 2));

      if (items.length > 0) {
        const { canvas, rects } = await this.buildSpritesheet(items);
        const ssJson = this.buildSpritesheetJson(rects, canvas.width, canvas.height);
        const pngBlob = await canvasToBlob(canvas);

        zip.file('spritesheet.json', JSON.stringify(ssJson, null, 2));
        zip.file('spritesheet.png',  pngBlob);
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      await saveWithPicker(blob, 'animation', [
        { description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } },
      ]);
      this.bus.emit('status', 'Exported .tao');
    } catch (err) {
      this.bus.emit('status', `Export failed: ${(err as Error).message}`);
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
        this.bus.emit('status', `Unsupported version ${project.version} (expected 2)`);
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
      this.bus.emit('status', `Import failed: ${(err as Error).message}`);
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

  private async buildSpritesheet(
    items: Array<{ id: string; blob: Blob }>,
  ): Promise<{ canvas: HTMLCanvasElement; rects: Map<string, { x: number; y: number; w: number; h: number }> }> {
    // Load all images to get dimensions
    const loaded = await Promise.all(
      items.map(async item => {
        const img = await loadImageFromBlob(item.blob);
        return { id: item.id, img, w: img.naturalWidth, h: img.naturalHeight };
      }),
    );

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
      ctx.drawImage(item.img, r.x, r.y);
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

/** Save blob via the File System Access API (native save dialog with folder + filename).
 *  Falls back to a filename prompt + triggerDownload for browsers without the API (e.g. Firefox). */
async function saveWithPicker(
  blob: Blob,
  suggestedName: string,
  types: Array<{ description?: string; accept: Record<string, string[]> }>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };
    try {
      handle = await picker({ suggestedName, types });
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
    const name = window.prompt('Save as:', suggestedName);
    if (name === null) return;  // user cancelled
    triggerDownload(blob, name.trim() || suggestedName);
  }
}
