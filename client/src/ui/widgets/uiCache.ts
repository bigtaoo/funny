/**
 * uiCache.ts — draw-once → bake → reuse for shared procedural UI parts.
 *
 * Background & convention: `UI_DESIGN.md` §2.1. Every scene used to redraw its
 * own back button / card frame / rarity border with `SketchPen` on each
 * `render()`. That is slow (full pen path per re-render) and lets the "same"
 * widget look different from scene to scene. The fix: draw a fixed-appearance,
 * multiply-reused widget once, bake it to a GPU texture, and from then on hand
 * out cheap `PIXI.Sprite`s of that texture.
 *
 * This is a thin, UI-flavoured wrapper over `render/bake.ts` (`bakeLazy`): the
 * renderer is injected once at app start via `setBakeRenderer`, and the texture
 * map lives there. Headless tests (no renderer) transparently fall back to a
 * live draw, so callers never branch.
 *
 * Cache key convention: `widget + size + variant` — e.g. `hdr:1080x230:zh` or
 * `rarity:epic:120x160`. Design-space sizes are constant per orientation, so a
 * key collision means a genuine reuse, not a stale mismatch. Language-dependent
 * widgets (anything with text) must fold the resolved label into the key so a
 * runtime language switch produces a new texture rather than a frozen one.
 */
import * as PIXI from 'pixi.js-legacy';
import { bakeLazy } from '../../render/bake';

/**
 * Cached texture for a fixed-appearance widget. `draw()` returns a display
 * object at local origin (0,0) sized `w × h`; it is invoked at most once per
 * key (only on a cache miss) and then discarded. Returns null with no renderer
 * wired — use {@link getCachedDisplay} if you want an automatic live fallback.
 */
export function getCachedTexture(
  key: string, draw: () => PIXI.DisplayObject, w: number, h: number,
): PIXI.Texture | null {
  return bakeLazy(key, draw, w, h);
}

/**
 * Display object for a fixed-appearance widget: a `PIXI.Sprite` of the cached
 * texture when a renderer is available, else the live-drawn object (headless
 * tests). Either way the caller just `addChild`s the result and positions it.
 */
export function getCachedDisplay(
  key: string, draw: () => PIXI.DisplayObject, w: number, h: number,
): PIXI.DisplayObject {
  const tex = bakeLazy(key, draw, w, h);
  return tex ? new PIXI.Sprite(tex) : draw();
}
