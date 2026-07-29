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
import { Skeleton } from '../skeleton/Skeleton';
import { TARGET_SCREEN_PX, SUPERSAMPLE, type SizeTierKey } from './unitSize';

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

// ── IOController ──────────────────────────────────────────────────────────────

export class IOController {
  /** Disk file identity of the currently loaded `.tao.editor`, so Save can overwrite it
   *  directly and Export can land the `.tao` alongside it without asking again. Desktop
   *  shell keeps an absolute path; browser (File System Access API) keeps a handle. Reset
   *  by any `loadEditorBlob()` — set afterwards by the disk-backed load paths only. */
  private editorFilePath:   string | null = null;
  private editorFileHandle: WritableFileHandle | null = null;
  /** Browser-only: remembered `.tao` save target so repeat exports don't re-prompt. */
  private taoFileHandle: WritableFileHandle | null = null;

  constructor(
    private readonly state:     AppState,
    private readonly animCtrl:  AnimationController,
    private readonly imageCtrl: ImageController,
    private readonly cmdManager: CommandManager,
    private readonly bus:        EventBus<AppEvents>,
  ) {
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportTao());
    document.getElementById('btn-save-as')?.addEventListener('click', () => this.saveEditorProjectAs());

    document.getElementById('btn-save-editor')?.addEventListener('click', () => this.saveEditorProject());
    document.getElementById('btn-load-editor')?.addEventListener('click', () => this.triggerLoadEditor());
    document.getElementById('editor-file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadEditorProject(file);
      (e.target as HTMLInputElement).value = '';
    });
  }

  /** True when running inside the desktop shell (NW Tool), which does real disk I/O via
   *  IPC instead of the browser's sandboxed File System Access API. */
  private isDesktop(): boolean {
    return !!window.nwDesktop?.fs;
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  /** "Load .editor" button: pick a file once, remember its disk identity for Save/Export. */
  private async triggerLoadEditor(): Promise<void> {
    if (this.isDesktop()) {
      await this.loadEditorFromDesktop();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picker = (window as any).showOpenFilePicker;
    if (typeof picker === 'function') {
      await this.loadEditorViaPicker();
      return;
    }
    // Firefox/Safari: no native picker or IPC available — plain file input, no
    // handle retained, so Save/Export fall back to asking for a location.
    (document.getElementById('editor-file-input') as HTMLInputElement | null)?.click();
  }

  private async loadEditorFromDesktop(): Promise<void> {
    try {
      const result = await window.nwDesktop!.fs.openFile([
        { name: 'Tao Editor Project', extensions: ['tao.editor'] },
      ]);
      if (result.canceled) return;
      if (result.error || !result.data || !result.path) {
        throw new Error(result.error ?? 'unknown error');
      }
      const ok = await this.loadEditorBlob(new Blob([result.data]), basename(result.path));
      if (ok) this.editorFilePath = result.path;
    } catch (err) {
      this.bus.emit('error', `Load failed: ${(err as Error).message}`);
    }
  }

  private async loadEditorViaPicker(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const picker = (window as any).showOpenFilePicker;
      const [handle]: WritableFileHandle[] = await picker({
        types: [{ description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } }],
      });
      const file = await handle.getFile();
      const ok = await this.loadEditorBlob(file, file.name);
      if (ok) this.editorFileHandle = handle;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return; // user cancelled
      this.bus.emit('error', `Load failed: ${(e as Error).message}`);
    }
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

  /** Overwrites the currently loaded `.tao.editor` file directly when its disk identity
   *  is known (desktop path or browser handle); only asks for a location the first time
   *  a brand-new project is saved, then remembers it for every save after that. */
  async saveEditorProject(): Promise<void> {
    this.bus.emit('status', 'Saving .tao.editor…');
    try {
      const blob = await this.buildEditorBlob();

      if (this.isDesktop()) {
        if (this.editorFilePath) {
          const result = await window.nwDesktop!.fs.writeFile(this.editorFilePath, await blob.arrayBuffer());
          if (!result.ok) throw new Error(result.error ?? 'write failed');
        } else {
          await this.saveEditorProjectAsDesktop(blob);
        }
        this.bus.emit('status', 'Project saved');
        return;
      }

      if (this.editorFileHandle) {
        const writable = await this.editorFileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        this.editorFileHandle = await saveWithPicker(blob, 'project', [
          { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
        ]);
      }
      this.bus.emit('status', 'Project saved');
    } catch (err) {
      this.bus.emit('error', `Save failed: ${(err as Error).message}`);
    }
  }

  /** "另存为" — save a copy of the current project under a new name/location, which then
   *  becomes the file Save/Export target from now on (same convention as Word/Photoshop). */
  async saveEditorProjectAs(): Promise<void> {
    this.bus.emit('status', 'Saving a copy…');
    try {
      const blob = await this.buildEditorBlob();

      if (this.isDesktop()) {
        const saved = await this.saveEditorProjectAsDesktop(blob);
        if (saved) this.bus.emit('status', `Saved a copy to ${basename(saved)}`);
        return;
      }

      const handle = await saveWithPicker(blob, 'project', [
        { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
      ], this.editorFileHandle);
      if (handle) {
        this.editorFileHandle = handle;
        this.bus.emit('status', 'Saved a copy — now editing that file');
      }
    } catch (err) {
      this.bus.emit('error', `Save failed: ${(err as Error).message}`);
    }
  }

  /** Shared desktop "ask for a location, write, remember it" step for both the
   *  first-ever save of a new project and the explicit "另存为". Returns the chosen
   *  path, or null if the user cancelled the dialog. */
  private async saveEditorProjectAsDesktop(blob: Blob): Promise<string | null> {
    const result = await window.nwDesktop!.fs.saveFileAs(
      { defaultPath: this.editorFilePath ?? undefined, filters: [{ name: 'Tao Editor Project', extensions: ['tao.editor'] }] },
      await blob.arrayBuffer(),
    );
    if (result.canceled) return null;
    if (result.error || !result.path) throw new Error(result.error ?? 'save failed');
    this.editorFilePath = result.path;
    return result.path;
  }

  loadEditorProject(file: File): Promise<boolean> {
    return this.loadEditorBlob(file, file.name);
  }

  /** Restore editor state from a `.tao.editor` archive (File or Blob). Returns whether the
   *  load succeeded, so disk-backed load paths know it's safe to remember the file's path/
   *  handle. Used by both the manual "Load .editor" button and project switching — always
   *  clears any remembered disk identity first; the disk-backed load paths re-set it after. */
  async loadEditorBlob(data: Blob, label: string): Promise<boolean> {
    this.editorFilePath   = null;
    this.editorFileHandle = null;
    this.taoFileHandle    = null;
    this.bus.emit('status', `Loading ${label}…`);
    try {
      const zip = await JSZip.loadAsync(data);

      const jsonFile = zip.file('editor.json');
      if (!jsonFile) throw new Error('editor.json missing from archive');
      const project = JSON.parse(await jsonFile.async('string')) as EditorProject;

      if (project.version !== 1) {
        this.bus.emit('error', `Unsupported editor version ${project.version}`);
        return false;
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
      return true;
    } catch (err) {
      this.bus.emit('error', `Load failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /** Build the `.tao` runtime bundle (animation.json + optional spritesheet) as a
   *  Blob, WITHOUT triggering a download. Shared by `exportTao()` (download) and the
   *  online workspace (upload) — the CI sync bridge cannot rebuild the spritesheet, so
   *  the browser-built `.tao` must be persisted alongside the `.tao.editor`. */
  async buildTaoBlob(): Promise<Blob> {
    // Size tier (export panel) + the rig's natural FK height drive the bake-down to an
    // absolute target resolution rather than the artist's canvas size (§4.5.3 B).
    const tier = this.readExportTier();
    const hNat = this.computeNaturalHeight();
    const animJson = this.buildAnimationJson(tier, hNat);

    // Bake each image down to the resolution it is actually displayed at (target
    // screen height × supersample), then rewrite binding.scaleX/Y to compensate.
    // The game renders sprite.scale = keyframe.scale × binding.scale, so pre-scaling
    // the pixels and dividing binding.scale by the same factor is visually identical
    // while shrinking the spritesheet — no runtime change needed.
    const items = await this.buildExportImages(animJson, tier, hNat);

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

  /** Writes the `.tao` bundle next to the loaded `.tao.editor` (desktop: derived same-
   *  directory path written directly; browser: remembered handle reused) so repeat
   *  exports never re-prompt. Only asks for a location when there's nothing to anchor to
   *  yet (no project loaded/saved this session). */
  async exportTao(): Promise<void> {
    this.bus.emit('status', 'Building .tao…');

    try {
      const blob = await this.buildTaoBlob();

      if (this.isDesktop()) {
        const fsApi = window.nwDesktop!.fs;
        const buf = await blob.arrayBuffer();
        const derivedPath = this.editorFilePath ? deriveTaoPath(this.editorFilePath) : null;
        if (derivedPath) {
          const result = await fsApi.writeFile(derivedPath, buf);
          if (!result.ok) throw new Error(result.error ?? 'write failed');
          this.bus.emit('status', `Exported ${basename(derivedPath)}`);
          return;
        }
        const result = await fsApi.saveFileAs({ filters: [{ name: 'Tao Animation', extensions: ['tao'] }] }, buf);
        if (result.canceled) return;
        if (result.error || !result.path) throw new Error(result.error ?? 'save failed');
        this.bus.emit('status', `Exported ${basename(result.path)}`);
        return;
      }

      if (this.taoFileHandle) {
        const writable = await this.taoFileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        this.taoFileHandle = await saveWithPicker(blob, 'animation', [
          { description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } },
        ], this.editorFileHandle);
      }
      this.bus.emit('status', 'Exported .tao');
    } catch (err) {
      this.bus.emit('error', `Export failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildAnimationJson(tier: SizeTierKey, hNat: number): SerializedProject {
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
      unitHeight: {
        tier,
        targetScreenPx: TARGET_SCREEN_PX[tier],
        naturalHeight:  Math.round(hNat),
        supersample:    SUPERSAMPLE,
      },
    };
  }

  /** Selected export size tier (export panel dropdown), default M. */
  private readExportTier(): SizeTierKey {
    const sel = document.getElementById('sel-export-tier') as HTMLSelectElement | null;
    const v = sel?.value as SizeTierKey | undefined;
    return (v === 'S' || v === 'M' || v === 'L' || v === 'XL') ? v : 'M';
  }

  /** H_nat — the rig's natural FK height (animator px) over rest pose + all keyframes. */
  private computeNaturalHeight(): number {
    return Skeleton.computeNaturalHeight(this.animCtrl.store.values(), this.state.boneLengthScales);
  }

  // ── Spritesheet building ──────────────────────────────────────────────────

  /** Fallback bake headroom, used only when H_nat is unknown (no clips → can't anchor
   *  to an absolute target). Bakes at 1.5× the largest displayed size for DPI/animation
   *  headroom — the legacy behaviour before per-tier absolute baking (§4.5.3 B). */
  private static readonly EXPORT_HEADROOM = 1.5;

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
  private async buildExportImages(
    animJson: SerializedProject,
    tier: SizeTierKey,
    hNat: number,
  ): Promise<Array<{ id: string; src: CanvasImageSource; w: number; h: number }>> {
    // G replaces the old flat headroom: absolute target resolution per tier.
    const G = hNat > 0
      ? (SUPERSAMPLE * TARGET_SCREEN_PX[tier]) / hNat
      : IOController.EXPORT_HEADROOM;
    const maxKf = this.computeMaxKeyframeScale();
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

/** Save blob via the File System Access API (native save dialog with folder + filename),
 *  returning the resulting handle so the caller can reuse it for silent overwrites on
 *  later saves/exports. Falls back to a filename prompt + triggerDownload for browsers
 *  without the API (e.g. Firefox), which returns null — no handle to remember there.
 *  `startIn`, when given, biases the dialog to open near that handle's location. */
async function saveWithPicker(
  blob: Blob,
  suggestedName: string,
  types: Array<{ description?: string; accept: Record<string, string[]> }>,
  startIn?: WritableFileHandle | null,
): Promise<WritableFileHandle | null> {
  // Pass a name that already carries exactly one canonical extension so neither
  // the native picker nor the user prompt can produce a doubled ".tao.editor".
  const ext       = primaryExt(types);
  const suggested = ensureSingleExt(suggestedName, ext);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: WritableFileHandle;
    try {
      handle = await picker({ suggestedName: suggested, types, ...(startIn ? { startIn } : {}) });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;  // user cancelled
      throw e;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle;
  } else {
    // Firefox / Safari fallback: prompt for filename, then trigger download.
    // The save path is controlled by the browser's download settings
    // (Firefox: Settings → Downloads → "Always ask you where to save files").
    const name = window.prompt('Save as:', suggested);
    if (name === null) return null;  // user cancelled
    triggerDownload(blob, ensureSingleExt(name.trim() || suggested, ext));
    return null;
  }
}

/** Minimal duck-typed shape of a `FileSystemFileHandle` (File System Access API), which
 *  TS's default lib doesn't declare — kept local rather than pulling in `@types/wicg-*`. */
interface WritableFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
}

/** Filename portion of an absolute disk path (desktop shell paths only need `\`/`/`). */
function basename(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

/** Same-directory `.tao` path for the loaded `.tao.editor` file, e.g.
 *  `…\runner\runner.tao.editor` → `…\runner\runner.tao`. */
function deriveTaoPath(editorPath: string): string {
  const suffix = '.tao.editor';
  return editorPath.toLowerCase().endsWith(suffix)
    ? editorPath.slice(0, -suffix.length) + '.tao'
    : `${editorPath}.tao`;
}
