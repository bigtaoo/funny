// ── Baked frame sheets (tools/unit-frames/bake.py) ────────────────────────────
//
// A battle unit drawn as frame sequences instead of a bone rig: every clip is one whole drawing
// warped offline and packed into a single sheet, plus a matching white contour per frame for the
// hit flash. Every frame texture shares one `orig` box with the figure's ground point at the same
// spot, so a sprite with a fixed anchor can swap frames without jumping.
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../../assets/assetIO';
import { ART_TEX_OPTIONS } from '../../assets/preloadTextures';

/** `[x, y, w, h, offsetX, offsetY]` — the rect in the sheet, and its top-left relative to the ground point. */
type FrameRect = [number, number, number, number, number, number];

/** The `.json` that bake.py writes next to the sheet. */
export interface FrameSheetJson {
  version: 1;
  /** Sheet px from ground to crown of the standing figure. */
  height: number;
  /** Attachment points in figure heights from the ground point (`hit` = where sparks land). */
  points: Record<string, [number, number]>;
  /** Ground shadow half-extents in figure heights. */
  shadow: [number, number];
  clips: Record<string, {
    fps: number;
    loop: boolean;
    /** Phase (0..1) of the frame the blow lands on; attack clips only. */
    hitAt?: number;
    frames: Array<{ body: FrameRect; line: FrameRect }>;
  }>;
}

export interface FrameClip {
  readonly fps: number;
  readonly loop: boolean;
  readonly body: readonly PIXI.Texture[];
  readonly line: readonly PIXI.Texture[];
  /** Seconds one playthrough takes at the authored rate. */
  readonly duration: number;
}

export interface FrameSheet {
  readonly height: number;
  readonly points: Readonly<Record<string, [number, number]>>;
  readonly shadow: readonly [number, number];
  readonly clips: ReadonlyMap<string, FrameClip>;
  /** Anchor (0..1) of the shared `orig` box that puts the ground point at the sprite's position. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * Build the per-frame textures. Every texture gets the same `orig` box (the union of all frames
 * around the ground point) with the frame's pixels placed inside it by `trim`, so swapping
 * textures on one sprite never moves the figure.
 */
export function buildFrameSheet(base: PIXI.BaseTexture, json: FrameSheetJson): FrameSheet {
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const clip of Object.values(json.clips)) {
    for (const f of clip.frames) {
      for (const [, , w, h, ox, oy] of [f.body, f.line]) {
        minX = Math.min(minX, ox); minY = Math.min(minY, oy);
        maxX = Math.max(maxX, ox + w); maxY = Math.max(maxY, oy + h);
      }
    }
  }
  minX = Math.floor(minX); minY = Math.floor(minY);
  const origW = Math.ceil(maxX) - minX;
  const origH = Math.ceil(maxY) - minY;
  const orig = new PIXI.Rectangle(0, 0, origW, origH);
  const tex = ([x, y, w, h, ox, oy]: FrameRect): PIXI.Texture =>
    new PIXI.Texture(base, new PIXI.Rectangle(x, y, w, h), orig,
      new PIXI.Rectangle(Math.round(ox - minX), Math.round(oy - minY), w, h));

  const clips = new Map<string, FrameClip>();
  for (const [name, c] of Object.entries(json.clips)) {
    clips.set(name, {
      fps: c.fps,
      loop: c.loop,
      body: c.frames.map(f => tex(f.body)),
      line: c.frames.map(f => tex(f.line)),
      duration: c.frames.length / c.fps,
    });
  }
  return {
    height: json.height,
    points: json.points,
    shadow: json.shadow,
    clips,
    anchorX: -minX / origW,
    anchorY: -minY / origH,
  };
}

const cache = new Map<string, Promise<FrameSheet>>();

/** Load a baked sheet (cached per png url; a failed load is forgotten so a later call retries). */
export function loadFrameSheet(pngUrl: string, json: FrameSheetJson): Promise<FrameSheet> {
  let p = cache.get(pngUrl);
  if (!p) {
    p = assetIO().textureSource(pngUrl).then(src => new Promise<PIXI.BaseTexture>((resolve, reject) => {
      const base = PIXI.BaseTexture.from(src, ART_TEX_OPTIONS);
      if (base.valid) { resolve(base); return; }
      base.once('loaded', () => resolve(base));
      base.once('error', (err: unknown) => reject(new Error(`frame sheet ${pngUrl}: ${String(err)}`)));
    })).then(base => buildFrameSheet(base, json))
      .catch((e: unknown) => { cache.delete(pngUrl); throw e; });
    cache.set(pngUrl, p);
  }
  return p;
}
