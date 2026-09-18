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

/**
 * Lower bound on the rendered width of a monospace string, derived from the string itself.
 *
 * Every text size in this game comes from the `FS` scale, and every label drawn through `txt()` is
 * `fontFamily: 'monospace'` — so a width is just a cell count: {@link MONO_CELL}.latin em per Latin
 * cell, one whole em per full-width CJK cell.
 *
 * Why not simply read `Text.width`: a layout that *branches* on measured width behaves differently
 * under `test/harness/pixiHeadless.ts`, whose `measureText` returns `length * 7` px regardless of
 * font size — so in the UI suite every string is a third of its real width and the branch is pinned
 * to one side, forever untested and silently wrong if it ever flips. Take `Math.max` of this and
 * the measured width: in a browser the measurement is the truth and wins (or ties), while headless
 * the estimate keeps the decision honest.
 */
export function monospaceWidth(text: string, fontSize: number): number {
  let cells = 0;
  for (const ch of text) cells += FULL_WIDTH.test(ch) ? MONO_CELL.fullWidth : MONO_CELL.latin;
  return cells * fontSize;
}

/**
 * Advance width of one monospace cell, as a fraction of the font size.
 *
 * These are the two numbers {@link monospaceWidth} is: a claim about a runtime, not a style choice.
 * `test/browser/textMetrics.spec.ts` measures the real advances in a real browser and fails if
 * either one stops bracketing the truth. Too HIGH and the estimate beats the real measurement
 * inside the `Math.max`, so a browser lays out from a guess instead of from what it can see; too
 * LOW and it stops resembling the runtime it is standing in for headless, which is the only thing
 * it is for.
 *
 * `latin` is 0.54 rather than the 0.6 this started as, because 'monospace' is a *request* and every
 * platform resolves it to a different face: Chrome on Windows picks Consolas, whose advance that
 * spec measured at **0.5498 em** — i.e. the original "lower bound" was over-reporting by 9% on the
 * one runtime it had ever been checked against. DejaVu Sans Mono and Menlo (Linux/macOS, and CI)
 * sit near 0.602, so 0.54 is the floor of that spread. Full-width cells are exactly 1 em.
 */
export const MONO_CELL = { latin: 0.54, fullWidth: 1 } as const;

/**
 * Full-width (CJK and friends) code points, which occupy one whole em in a monospace run. The `u`
 * flag is load-bearing for the last range: the CJK extensions live above the BMP, and
 * {@link monospaceWidth} iterates code points, so a surrogate pair reaches this as ONE character
 * and has to match as one.
 */
const FULL_WIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;
