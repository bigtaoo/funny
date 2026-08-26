/**
 * icons.ts — the public entry point for every small UI glyph in the game.
 *
 * Once upon a time this file WAS the icons: ~850 lines of `SketchPen` line art, one `draw*` function
 * per glyph, dispatched through a `DRAW` record. Batches 1–7 of the AI-art programme
 * (`design/product/tab-icon-art-prompts*.md`) replaced all of it — the last 44 procedural kinds went
 * on 2026-08-25 — so nothing is drawn here any more and the module is a pure dispatcher over two
 * tables of AI-drawn PNGs:
 *
 *   - {@link ./icons/tabIconRaster} — the 46 tab/title icons plus the coin art. `color` is only a
 *     light/dark HINT there; `tabIconVariant` maps it onto one of three inks baked at pack time.
 *   - {@link ./icons/inkIconRaster} — the 44 content glyphs (equipment affixes, UI dingbats, SLG
 *     buildings, the title ladder). One white master each, tinted live, so `color` is taken
 *     literally — exactly the contract the procedural glyphs had.
 *
 * Both are re-exported below, so `render/icons` remains the single import site for callers.
 *
 * The positioning contract is unchanged from the SketchPen era: an icon occupies an `s × s` box at
 * local origin (0,0) with its artwork centred, so a caller can position the returned display object
 * by its top-left corner.
 */
import * as PIXI from 'pixi.js-legacy';
import {
  TAB_ICON_RASTER, tabIconVariant, buildRasterTabIcon, preloadTabIconTextures,
  type RasterIconKind, type RasterIconVariant,
} from './icons/tabIconRaster';
import {
  INK_ICON_ART, buildInkIcon, preloadInkIconTextures, type InkIconKind,
} from './icons/inkIconRaster';

export {
  TAB_ICON_RASTER, tabIconVariant, preloadTabIconTextures,
  BACK_ARROW_ART, BACK_ARROW_ASPECT, buildRasterTabIcon,
} from './icons/tabIconRaster';
export type { RasterIconKind, RasterIconVariant } from './icons/tabIconRaster';
export { INK_ICON_ART, INK_ICON_ALIASES, preloadInkIconTextures, buildInkIcon } from './icons/inkIconRaster';
export type { InkIconKind } from './icons/inkIconRaster';

/** Every icon `buildIcon` can build — a tinted ink glyph or a variant-baked raster tab icon. */
export type IconKind = InkIconKind | RasterIconKind;

/**
 * Warm BOTH icon tables into the PIXI texture cache. Call this (and re-render on the promise) from
 * any scene that would otherwise show a blank box on its first frame — every kind is a PNG now, so
 * unlike the SketchPen era there is nothing that can draw itself synchronously.
 *
 * `preloadTabIconTextures` / `preloadInkIconTextures` stay exported for a caller that genuinely
 * wants one half — HUDView warms only the ink table, since the battle HUD's single raster glyph is
 * `ink` — but a scene should reach for this.
 */
export function preloadIconArt(): Promise<void> {
  return Promise.all([preloadTabIconTextures(), preloadInkIconTextures()]).then(() => undefined);
}

/**
 * A hand-drawn icon sized `size × size`, drawn in `color`. Position the returned display object by
 * its top-left corner; the artwork is centred in the box.
 *
 * `color` means different things to the two tables behind this — literal ink for an
 * {@link InkIconKind}, a light/dark surface hint for a {@link RasterIconKind} (see each module's
 * header). `opts.variant` only affects the latter: pass `'content'` when a raster tab icon is being
 * used as page content rather than as a tab, so it gets the full-strength ink instead of the
 * de-emphasised tab grey `color` alone would select.
 *
 * Neither path is routed through `uiCache` any more — both return a sprite over an already-static
 * texture, which `PIXI.Texture.from` caches by url, so there is nothing to bake.
 */
export function buildIcon(
  kind: IconKind, size: number, color: number, opts?: { variant?: RasterIconVariant },
): PIXI.DisplayObject {
  const s = Math.round(size);
  const raster = (TAB_ICON_RASTER as Partial<Record<IconKind, Record<RasterIconVariant, string>>>)[kind];
  if (raster) return buildRasterTabIcon(raster[opts?.variant ?? tabIconVariant(color)], s);
  return buildInkIcon(INK_ICON_ART[kind as InkIconKind], s, color);
}
