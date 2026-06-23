import * as PIXI from 'pixi.js';
import type { EventBus, AppEvents } from '../core/EventBus';

// ── Slot definitions ──────────────────────────────────────────────────────────

/** All bone slots (10 bones, no root since root has no sprite). */
export const BONE_SLOTS = [
  'spine', 'head',
  'r_upper_arm', 'l_upper_arm',
  'r_lower_arm', 'l_lower_arm',
  'r_upper_leg', 'l_upper_leg',
  'r_lower_leg', 'l_lower_leg',
] as const;

export type BoneSlot = typeof BONE_SLOTS[number];

/** The shadow attachment point image slot. */
export const SHADOW_SLOT = 'shadow' as const;

/** All image slots: 10 bones + shadow = 11. */
export const ALL_SLOTS = [...BONE_SLOTS, SHADOW_SLOT] as const;

/** Default render layer order for bone sprites (higher = in front).
 *  r_lower_leg is furthest back, l_upper_arm is furthest forward. */
export const DEFAULT_ZORDER: Record<string, number> = {
  r_lower_leg: 0,
  r_upper_leg: 1,
  l_lower_leg: 2,
  l_upper_leg: 3,
  r_lower_arm: 4,
  r_upper_arm: 5,
  spine:       6,
  head:        7,
  l_lower_arm: 8,
  l_upper_arm: 9,
};

// ── Filename → slot auto-detection ───────────────────────────────────────────

/** Try to infer a slot from a filename (case-insensitive, without extension). */
function guessSlot(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[-\s]/g, '_');
  for (const slot of ALL_SLOTS) {
    if (base === slot) return slot;
  }
  return null;
}

// ── ImageController ───────────────────────────────────────────────────────────

export class ImageController {
  private readonly _textures     = new Map<string, PIXI.Texture>();
  private readonly _baseTextures = new Map<string, PIXI.BaseTexture>();
  private readonly _blobs        = new Map<string, Blob>();    // for export
  private readonly _names        = new Map<string, string>();  // display filename

  constructor(private readonly bus: EventBus<AppEvents>) {}

  // ── Accessors ───────────────────────────────────────────────────────────────

  getTexture(slotId: string): PIXI.Texture | undefined {
    return this._textures.get(slotId);
  }

  getFilename(slotId: string): string | undefined {
    return this._names.get(slotId);
  }

  getBlob(slotId: string): Blob | undefined {
    return this._blobs.get(slotId);
  }

  /** True when all 10 bone slots have a texture loaded. */
  hasAllBoneImages(): boolean {
    return BONE_SLOTS.every(s => this._textures.has(s));
  }

  // ── Load individual file ────────────────────────────────────────────────────

  async setImage(slotId: string, file: File): Promise<void> {
    return this.setBlob(slotId, file, file.name);
  }

  /** Load a Blob (File or extracted sub-image) into a slot. */
  async setBlob(slotId: string, blob: Blob, displayName: string): Promise<void> {
    this.clearSlot(slotId);

    const url  = URL.createObjectURL(blob);
    const base = PIXI.BaseTexture.from(url);
    const tex  = new PIXI.Texture(base);

    this._blobs.set(slotId, blob);
    this._names.set(slotId, displayName);
    this._textures.set(slotId, tex);
    this._baseTextures.set(slotId, base);

    // Wait for texture to load so width/height are available for export
    await new Promise<void>(resolve => {
      if (base.valid) { resolve(); return; }
      base.on('loaded', () => resolve());
      base.on('error',  () => resolve()); // resolve anyway, export will skip
    });

    this.bus.emit('images:change', slotId);
    this.bus.emit('status', `Loaded ${displayName} → ${slotId}`);
  }

  // ── Bulk import from FileList ───────────────────────────────────────────────

  async importFiles(files: FileList | File[]): Promise<void> {
    const arr = Array.from(files);
    for (const file of arr) {
      const slot = guessSlot(file.name);
      if (slot) {
        await this.setImage(slot, file);
      } else {
        this.bus.emit('error', `Cannot auto-detect slot for "${file.name}" — assign manually`);
      }
    }
  }

  // ── Remove ──────────────────────────────────────────────────────────────────

  removeImage(slotId: string): void {
    if (!this._textures.has(slotId)) return;
    this.clearSlot(slotId);
    this.bus.emit('images:change', slotId);
  }

  /** Remove every loaded image (used when switching / creating projects). */
  clearAll(): void {
    for (const slotId of [...this._textures.keys()]) {
      this.clearSlot(slotId);
      this.bus.emit('images:change', slotId);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private clearSlot(slotId: string): void {
    const tex  = this._textures.get(slotId);
    const base = this._baseTextures.get(slotId);
    if (tex)  { tex.destroy(false);  this._textures.delete(slotId); }
    if (base) { base.destroy();      this._baseTextures.delete(slotId); }

    const blob = this._blobs.get(slotId);
    if (blob) {
      // If it's an object-URL-backed blob, revoke; File objects don't need this
      // but revoking a File's URL is harmless
      this._blobs.delete(slotId);
    }
    this._names.delete(slotId);
  }

  destroy(): void {
    for (const slotId of [...this._textures.keys()]) {
      this.clearSlot(slotId);
    }
  }
}
