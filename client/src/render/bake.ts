/**
 * bake.ts — render procedural Graphics once to a cached texture.
 *
 * Static notebook art (board paper, ruled grid, frames) is drawn with the
 * `sketch.ts` pen and then baked to a GPU texture via `renderer.generateTexture`
 * so it costs nothing per frame. Dynamic layers (highlights, cracks, units)
 * keep drawing live on top — and because every layer derives its coordinates
 * from the same `ILayout`, the baked sprite and the live overlays stay aligned.
 *
 * The active renderer is injected once at app start (`setBakeRenderer`). If no
 * renderer is available (e.g. headless tests), callers fall back to live draw.
 */
import * as PIXI from 'pixi.js-legacy';

let renderer: PIXI.IRenderer | null = null;
const cache = new Map<string, PIXI.RenderTexture>();

/** Called once after the PIXI.Application is created (see app.ts). */
export function setBakeRenderer(r: PIXI.IRenderer): void {
  renderer = r;
}

export function hasBakeRenderer(): boolean {
  return renderer !== null;
}

/**
 * Draw `displayObject` (local coords, origin at 0,0) into a texture sized
 * `w × h`, cached under `key`. Repeated calls with the same key return the
 * cached texture without re-rendering — the board background is identical
 * across battles for a given (orientation, size, cellSize).
 *
 * Returns null if no renderer is wired; the caller should then add the
 * `displayObject` directly instead.
 */
export function bake(key: string, displayObject: PIXI.DisplayObject, w: number, h: number): PIXI.Texture | null {
  if (!renderer) return null;
  const hit = cache.get(key);
  if (hit) return hit;

  const tex = PIXI.RenderTexture.create({
    width:      Math.ceil(w),
    height:     Math.ceil(h),
    resolution: renderer.resolution,
  });
  renderer.render(displayObject, { renderTexture: tex });
  cache.set(key, tex);
  return tex;
}

/** Drop all cached textures (e.g. on a hard relayout). */
export function clearBakeCache(): void {
  for (const tex of cache.values()) tex.destroy(true);
  cache.clear();
}
