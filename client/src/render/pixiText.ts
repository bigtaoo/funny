/**
 * pixiText.ts — the one place PIXI text is constructed with CJK-safe padding.
 *
 * PIXI measures a font's ascent from Latin metrics; CJK glyphs (汉字) are taller
 * than that ascent, so their top strokes get clipped at row 0 of the generated
 * text canvas ("汉字顶部被截断"). The fix is `TextStyle.padding`, which enlarges
 * ONLY the backing texture — `trim`/`orig` compensate, so the reported
 * width/height and the on-screen position are unchanged (verified against
 * @pixi/text `Text.updateTexture`). There is therefore no layout shift, and it is
 * always safe to add.
 *
 * Two layers, so no text surface can clip regardless of how it's built:
 *   1. `makeText()` — the canonical factory. Prefer it over `new PIXI.Text(...)`
 *      everywhere; it applies padding proportional to fontSize.
 *   2. `installTextPaddingFloor()` — a global default-padding floor installed once
 *      at boot, so even a stray `new PIXI.Text(...)` that never migrated (or a
 *      future one) still can't clip.
 */
import * as PIXI from 'pixi.js-legacy';

/** Anti-clip padding (px) for a given font size. ~15% of the size clears the
 *  tallest CJK glyph tops at every scale we use. */
export function cjkPadding(fontSize: number): number {
  return Math.ceil((Number(fontSize) || 16) * 0.15);
}

/**
 * Canonical `PIXI.Text` factory — use instead of `new PIXI.Text(...)`.
 * Applies CJK anti-clip padding proportional to the style's fontSize, unless the
 * caller set `padding` explicitly (then theirs wins).
 */
export function makeText(
  text: string,
  style: Partial<PIXI.ITextStyle> | PIXI.TextStyle = {},
): PIXI.Text {
  const explicitPad = (style as Partial<PIXI.ITextStyle>).padding;
  const t = new PIXI.Text(text, style);
  if (explicitPad == null) t.style.padding = cjkPadding(t.style.fontSize as number);
  return t;
}

/**
 * Raise PIXI's global default text padding to a floor, once at app boot. Belt-and-
 * suspenders for any `new PIXI.Text(...)` that bypasses {@link makeText}. A fixed
 * floor (rather than proportional) is fine here: padding never shifts layout, and
 * the small texture overhead on tiny fonts is negligible.
 */
export function installTextPaddingFloor(px = 8): void {
  if (PIXI.TextStyle.defaultStyle.padding < px) PIXI.TextStyle.defaultStyle.padding = px;
}
