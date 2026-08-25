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
 *
 * ── Why page-sized bakes need their own resolution (2026-08-25) ──────────────
 *
 * Everything baked here is drawn in DESIGN space, but `ScalingManager` shows the
 * design rect at `gameLayer.scale` — 0.25 on a phone. Baking at the renderer's own
 * resolution therefore oversamples by 1/scale in each axis: on the iPhone 13 in-app
 * WebView behind the 2026-08-25 crash loop (viewport 750x270 CSS px, dpr 3, design
 * rect 3000x1080, scale 0.25) one full-page layer came out 9000x3240 = 111 MB, of
 * which 15/16ths were pixels that could never reach the screen. The lobby draws
 * three of them (paper + C-doodles + wear), so the first lobby paint asked a
 * memory-capped WKWebView for 334 MB in one burst and the OS killed the renderer
 * process outright — `aliveMs:0`, no `jserror`, no `webgl_lost`, no `mem` report,
 * on a reload loop.
 *
 * So a bake that is laid out 1:1 in design space and never magnified passes
 * `pageScale: true` and is sized for the DEVICE pixels it actually covers
 * ({@link pageBakeResolution}). Small UI chrome (panel-frame atlas, uiCache
 * buttons/borders, `boil` frames) deliberately does NOT: those are kilobytes each,
 * and some ride on containers that animate above scale 1, where a device-exact
 * texture would visibly soften.
 */
import * as PIXI from 'pixi.js-legacy';

let renderer: PIXI.IRenderer | null = null;
/**
 * On-screen scale of the design-space layer — `ScalingManager.gameLayer.scale`, pushed in on every
 * `applyScaling()`. 1 until a ScalingManager exists, which is also the safe default: it reproduces
 * the pre-2026-08-25 sizing rather than guessing a scale.
 */
let designScale = 1;

const cache = new Map<string, PIXI.RenderTexture>();

/** Called once after the PIXI.Application is created (see app.ts). */
export function setBakeRenderer(r: PIXI.IRenderer): void {
  renderer = r;
}

export function hasBakeRenderer(): boolean {
  return renderer !== null;
}

/**
 * Tell the bake layer how large the design rect is drawn on screen. Called by
 * `ScalingManager.applyScaling` (construction and every resize) — the one place that computes it.
 */
export function setDesignScale(scale: number): void {
  if (Number.isFinite(scale) && scale > 0) designScale = scale;
}

/**
 * Quantization step for {@link pageBakeResolution}: sixteenths.
 *
 * Quantizing at all is what keeps the cache from minting a fresh texture every time a mobile chrome
 * bar slides and nudges the scale by a fraction of a percent. Sixteenths rather than eighths because
 * the step is a *relative* cost at low resolutions — an eighth of slack on a phone's ~0.75 is 17%
 * per axis in the worst case (36% on area), a sixteenth is half that. PIXI itself rounds
 * `width * resolution` to whole pixels (BaseTexture), so a fractional resolution is safe.
 */
const RES_STEP = 16;

/**
 * Floor for {@link pageBakeResolution}, and it is a robustness guard rather than a quality knob.
 *
 * A client can boot with a degenerate viewport — `window.innerWidth/innerHeight` read 0 before the
 * page has layout (a hidden tab, an offscreen embed; the same WebKit "not settled yet" class that
 * `resettledLayout` already exists for). `createLayout(0, 0)` then yields a scale near 1/2000, and
 * without a floor every page layer would bake at 1/16 and look like a smear. The
 * resolution-in-cache-key means a real viewport mints the correct texture as soon as one arrives, so
 * this only has to bound the damage in the window before that — and it costs nothing to be generous:
 * the smallest legitimate value in the field is a dpr-1 phone at scale 0.25, and a 1920x1080 design
 * rect at 0.25 is 0.5 MB.
 */
const MIN_PAGE_RES = 0.25;

/**
 * Resolution for a bake that covers design space 1:1 — the device pixels it actually occupies,
 * `renderer.resolution x designScale`, rounded UP to the next {@link RES_STEP}th.
 *
 * Two clamps, both deliberate:
 *   - rounded **up**, so the texture is never sampled below one texel per device pixel. That trades
 *     a few percent per axis of slack for "no softness anywhere".
 *   - capped at `renderer.resolution`, so this can only ever LOWER the cost relative to the old
 *     behaviour. A 4K desktop (design rect magnified past 1:1) keeps exactly the texture it had
 *     before, instead of silently growing 4x on the strength of a memory fix.
 *
 * Then floored at {@link MIN_PAGE_RES} — but the cap wins over the floor, so a renderer that is
 * itself below the floor (a deliberately low-resolution target) is still never inflated.
 */
export function pageBakeResolution(): number {
  const base = renderer?.resolution ?? 1;
  const quantized = Math.ceil(base * designScale * RES_STEP) / RES_STEP;
  return Math.min(base, Math.max(MIN_PAGE_RES, quantized));
}

/** Options shared by {@link bake} and {@link bakeLazy}. */
export interface BakeOpts {
  /**
   * This texture is laid out 1:1 in design space and never magnified (page backgrounds, the board
   * sheet, full-page atmosphere layers) — so size it for the device pixels it covers rather than
   * for the renderer's resolution. See the file header for what this is worth.
   */
  pageScale?: boolean;
}

function resolutionFor(opts?: BakeOpts): number {
  return opts?.pageScale ? pageBakeResolution() : (renderer?.resolution ?? 1);
}

/**
 * Cache key. The resolution is part of it: the same design rect can be shown at different
 * on-screen scales within one session (chrome bars sliding, a window drag, a rotation that happens
 * to preserve the design rect's aspect), and a hit that ignored resolution would hand back a
 * texture baked for a different sampling rate — permanently soft, with nothing to blame it on.
 */
function cacheKey(key: string, resolution: number): string {
  return `${key}@${resolution}`;
}

/**
 * Draw `displayObject` (local coords, origin at 0,0) into a texture sized
 * `w x h`, cached under `key`. Repeated calls with the same key return the
 * cached texture without re-rendering — the board background is identical
 * across battles for a given (orientation, size, cellSize).
 *
 * Returns null if no renderer is wired; the caller should then add the
 * `displayObject` directly instead.
 */
export function bake(
  key: string, displayObject: PIXI.DisplayObject, w: number, h: number, opts?: BakeOpts,
): PIXI.Texture | null {
  if (!renderer) return null;
  const resolution = resolutionFor(opts);
  const ck = cacheKey(key, resolution);
  const hit = cache.get(ck);
  if (hit) return hit;

  const tex = PIXI.RenderTexture.create({
    width:      Math.ceil(w),
    height:     Math.ceil(h),
    resolution,
  });
  renderer.render(displayObject, { renderTexture: tex });
  cache.set(ck, tex);
  return tex;
}

/**
 * Renderer resolution the {@link bake} family draws at. Callers that bake a
 * `PIXI.Text` must stamp this onto `text.resolution` before handing it over:
 * `PIXI.Text` picks its own glyph-canvas resolution from `settings.RESOLUTION`,
 * which is not necessarily the renderer's, and any mismatch shows up as a soft
 * or over-sharp bake. 1 when no renderer is wired.
 *
 * Deliberately NOT {@link pageBakeResolution}: this is what `fastText` rasterizes glyph canvases
 * at, glyph sprites do ride on containers that scale above 1 (card reveals, modal pop-ins), and
 * text is where softness is most visible and cheapest to avoid — a glyph atlas is kilobytes.
 */
export function bakeResolution(): number {
  return renderer?.resolution ?? 1;
}

/**
 * Lazy variant of {@link bake}: only invokes `draw()` on a cache miss, so a
 * cache hit costs nothing (no Graphics built, no layout). The drawn object is
 * rendered into the texture and then destroyed — the caller never sees it; it
 * gets a fresh `PIXI.Sprite(tex)` instead. Returns null with no renderer wired
 * (headless tests), in which case the caller should draw live.
 *
 * This is the primitive behind {@link ./uiCache} (`getCachedTexture`): shared UI
 * chrome (back button, frames, rarity borders) is drawn once and reused.
 */
export function bakeLazy(
  key: string, draw: () => PIXI.DisplayObject, w: number, h: number, opts?: BakeOpts,
): PIXI.Texture | null {
  if (!renderer) return null;
  const resolution = resolutionFor(opts);
  const ck = cacheKey(key, resolution);
  const hit = cache.get(ck);
  if (hit) return hit;

  const obj = draw();
  const tex = PIXI.RenderTexture.create({
    width:      Math.ceil(w),
    height:     Math.ceil(h),
    resolution,
  });
  renderer.render(obj, { renderTexture: tex });
  cache.set(ck, tex);
  obj.destroy({ children: true });
  return tex;
}

/** One cached bake, for {@link bakeStats}. */
export interface BakeEntryStat {
  key: string;
  /** Texture size in real (device) pixels. */
  w: number;
  h: number;
  bytes: number;
}

/**
 * What the bake cache currently holds, in BYTES — the number that would have named this cache as
 * the 2026-08-25 crash's cause on sight, where a count of 3 said nothing at all. Surfaced by
 * `MemoryMonitor.dump()`; `largest` carries the cache key, so a report points straight at the call
 * site.
 *
 * Entries are never evicted (that is the cache's whole point for board/page art, which is identical
 * for the lifetime of a layout), so this only grows as the player visits more screens — which makes
 * it exactly the signal for "did the page-sized bakes stay bounded".
 */
export function bakeStats(): { count: number; bytes: number; largest: BakeEntryStat | null } {
  let bytes = 0;
  let largest: BakeEntryStat | null = null;
  for (const [key, tex] of cache) {
    const bt = tex.baseTexture;
    const w = bt?.realWidth ?? 0;
    const h = bt?.realHeight ?? 0;
    const b = w * h * 4; // RGBA8; the RenderTextures here are never mipmapped
    bytes += b;
    if (!largest || b > largest.bytes) largest = { key, w, h, bytes: b };
  }
  return { count: cache.size, bytes, largest };
}

/** Drop all cached textures (e.g. on a hard relayout). */
export function clearBakeCache(): void {
  for (const tex of cache.values()) tex.destroy(true);
  cache.clear();
}

/** Test seam: forget the injected design scale (module-scope state, like the renderer). */
export function resetDesignScaleForTest(): void {
  designScale = 1;
}
