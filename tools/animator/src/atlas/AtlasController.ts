import * as PIXI from 'pixi.js';
import type { AtlasAsset, AtlasFrame } from '../core/types';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { CommandManager } from '../core/CommandManager';

// ── TexturePacker JSON shapes ─────────────────────────────────────────────────

interface TPFrameHash {
  frame:     { x: number; y: number; w: number; h: number };
  pivot?:    { x: number; y: number };
  sourceSize?: { w: number; h: number };
}

interface TPJsonHash {
  frames: Record<string, TPFrameHash>;
  meta:   { image: string };
}

interface TPJsonArray {
  frames: Array<{ filename: string } & TPFrameHash>;
  meta:   { image: string };
}

// ── AtlasController ───────────────────────────────────────────────────────────

export class AtlasController {
  private readonly _atlases    = new Map<string, AtlasAsset>();
  private readonly _textures   = new Map<string, PIXI.Texture>();   // frameId → Texture
  private readonly _baseTextures = new Map<string, PIXI.BaseTexture>(); // atlasId → BaseTexture

  constructor(
    private readonly bus: EventBus<AppEvents>,
    private readonly cmdManager: CommandManager,
  ) {}

  // ── Public accessors ────────────────────────────────────────────────────────

  get atlases(): ReadonlyMap<string, AtlasAsset> { return this._atlases; }

  getFrame(frameId: string): AtlasFrame | undefined {
    for (const asset of this._atlases.values()) {
      const f = asset.frames.get(frameId);
      if (f) return f;
    }
    return undefined;
  }

  getTexture(frameId: string): PIXI.Texture | undefined {
    return this._textures.get(frameId);
  }

  getAllFrameIds(): string[] {
    const ids: string[] = [];
    for (const asset of this._atlases.values()) {
      asset.frames.forEach((_, id) => ids.push(id));
    }
    return ids;
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  async importAtlas(jsonFile: File, imageFile?: File | null): Promise<void> {
    const atlasId = jsonFile.name.replace(/\.[^.]+$/, '');

    const jsonText = await jsonFile.text();
    const json = JSON.parse(jsonText) as TPJsonHash | TPJsonArray;
    const frames = this.parseFrames(json);

    // Resolve image URL: explicit file > data URL in meta > relative URL in meta
    let imageUrl: string;
    if (imageFile) {
      imageUrl = await this.loadImageUrl(imageFile);
    } else {
      const metaImage = (json as TPJsonHash).meta?.image ?? '';
      if (!metaImage) throw new Error('No image file provided and no meta.image in JSON');
      imageUrl = metaImage; // works for data: and http: URLs
    }

    const base = PIXI.BaseTexture.from(imageUrl);
    base.on('error', () => {
      this.bus.emit('status', `Image load failed for atlas "${atlasId}"`);
    });
    const asset: AtlasAsset = { id: atlasId, frames };

    // Destroy any previous atlas with same id
    this.destroyAtlas(atlasId);

    this._atlases.set(atlasId, asset);
    this._baseTextures.set(atlasId, base);

    // Create PIXI.Texture per frame
    frames.forEach((frame, frameId) => {
      const tex = new PIXI.Texture(
        base,
        new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
      );
      this._textures.set(frameId, tex);
    });

    this.bus.emit('atlas:change');
    this.bus.emit('status', `Atlas "${atlasId}" loaded — ${frames.size} frames`);
  }

  // ── Remove ──────────────────────────────────────────────────────────────────

  removeAtlas(atlasId: string): void {
    this.destroyAtlas(atlasId);
    this.bus.emit('atlas:change');
    this.bus.emit('status', `Atlas "${atlasId}" removed`);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private destroyAtlas(atlasId: string): void {
    const asset = this._atlases.get(atlasId);
    if (!asset) return;

    asset.frames.forEach((_, frameId) => {
      this._textures.get(frameId)?.destroy(false);
      this._textures.delete(frameId);
    });

    this._baseTextures.get(atlasId)?.destroy();
    this._baseTextures.delete(atlasId);
    this._atlases.delete(atlasId);
  }

  private parseFrames(json: TPJsonHash | TPJsonArray): Map<string, AtlasFrame> {
    const frames = new Map<string, AtlasFrame>();

    if (Array.isArray((json as TPJsonArray).frames)) {
      // Array format
      for (const entry of (json as TPJsonArray).frames) {
        frames.set(entry.filename, this.tpFrameToAtlas(entry));
      }
    } else {
      // Hash format
      for (const [name, entry] of Object.entries((json as TPJsonHash).frames)) {
        frames.set(name, this.tpFrameToAtlas(entry));
      }
    }

    return frames;
  }

  private tpFrameToAtlas(entry: TPFrameHash): AtlasFrame {
    return {
      x:      entry.frame.x,
      y:      entry.frame.y,
      w:      entry.frame.w,
      h:      entry.frame.h,
      pivotX: entry.pivot?.x ?? 0.5,
      pivotY: entry.pivot?.y ?? 0.5,
    };
  }

  private loadImageUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read image file'));
      reader.readAsDataURL(file);
    });
  }
}
