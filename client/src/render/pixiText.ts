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
import { UI_FONT_FAMILY } from './theme';

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
  // A plain style that names no family gets the UI's one family (render/theme.ts) instead of
  // PIXI's built-in default, Arial — the hand cards and the drag ghost drew in Arial for months
  // because nobody wrote a family down. A TextStyle instance is the caller's own object; leave it.
  const withFamily = style instanceof PIXI.TextStyle || style.fontFamily != null
    ? style
    : { ...style, fontFamily: UI_FONT_FAMILY };
  const t = new PIXI.Text(text, withFamily);
  if (explicitPad == null) t.style.padding = cjkPadding(t.style.fontSize as number);
  return t;
}

/**
 * `text.width`, computed WITHOUT rasterizing the text.
 *
 * Reading `PIXI.Text.width` runs `updateText()`: measure, resize the canvas, `fillText` every line and
 * mark the texture for re-upload. That is the right price for a label that will be shown — but a
 * fit-to-width loop that reads it for sizes it then throws away pays the whole rasterization per
 * probe. On the card roster's first open that was 43 of the grid's 86 ms (2026-09-28 probe:
 * `txtFit` rasterizing every name and team tag that did not fit, then rasterizing it again).
 *
 * Same numbers `updateText` + `updateTexture` would produce, from the same `TextMetrics` call —
 * including the canvas's whole-device-pixel rounding at the text's current resolution — so a
 * decision made on this agrees with the width the label will have once it is drawn. `trim` changes
 * the canvas after drawing, so a trimmed style falls back to the real getter.
 */
export function measuredWidth(t: PIXI.Text): number {
  const style = t.style;
  if (style.trim) return t.width;
  const m = PIXI.TextMetrics.measureText(t.text || ' ', style, style.wordWrap, t.canvas);
  const res = t.resolution;
  const canvasW = Math.ceil(Math.ceil(Math.max(1, m.width) + style.padding * 2) * res);
  return Math.abs(t.scale.x) * (canvasW / res - style.padding * 2);
}

/**
 * Build every new `PIXI.Text` at the renderer's resolution instead of `settings.RESOLUTION` (1).
 *
 * `PIXI.Text` is auto-resolution: it starts at `Text.defaultResolution ?? settings.RESOLUTION` and
 * switches to `renderer.resolution` — re-rasterizing — the first time it is rendered. Nearly every
 * label in this game has its `width`/`height` read during layout, before that first render, and the
 * read rasterizes it. So on any renderer above resolution 1 (every phone, every retina screen; the
 * cap is 2) each such label was drawn twice: once at 1x for layout, then again at 2x on screen.
 * Setting the default up front makes the layout rasterization the only one. `autoResolution` stays
 * on, so a later change of renderer resolution (render/adaptiveResolution.ts) still re-rasterizes
 * whatever is on screen at the new value.
 *
 * Call with the renderer's resolution at boot, and again whenever it changes.
 */
export function setTextResolution(resolution: number): void {
  if (Number.isFinite(resolution) && resolution > 0) PIXI.Text.defaultResolution = resolution;
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
 * Make the UI's one family (render/theme.ts `UI_FONT_FAMILY`) PIXI's default, once at app boot —
 * the family counterpart of {@link installTextPaddingFloor}: a `new PIXI.Text` / `new
 * PIXI.TextStyle` that bypasses {@link makeText} and names no family would otherwise get Arial.
 */
export function installUiFontDefault(): void {
  PIXI.TextStyle.defaultStyle.fontFamily = UI_FONT_FAMILY;
}

/**
 * Lower bound on the rendered width of a monospace string, derived from the string itself.
 *
 * Every text size in this game comes from the `FS` scale, and every label drawn through `txt()` is
 * `fontFamily: UI_FONT_FAMILY` (monospace) — so a width is just a cell count: {@link MONO_CELL}.latin em per Latin
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

/** Punctuation that must not open a line (kinsoku): it rides on the end of the previous one. */
const NO_LINE_START = /^[，。、；：？！）」』》〉】’”…,.;:?!)\]}%]$/u;
/** Punctuation that must not close a line: it rides into the start of the next one. */
const NO_LINE_END = /^[（「『《〈【‘“([{]$/u;

/**
 * Split text into the units Pixi's `wordWrap` may break between — the replacement for
 * `TextMetrics.tokenize` that {@link installCjkWordWrap} installs.
 *
 * Pixi's own tokenizer splits only at breaking spaces and newlines, so a Chinese sentence is one
 * unbreakable "word": without `breakWords` it runs straight off the panel, and with it Pixi flushes
 * the current line before every too-wide "word", so `向 Apple 申请退款，Apple 会…` comes out as a
 * stair of half-empty lines. Here every full-width character is a token of its own, a run of
 * Latin (or any non-full-width) characters stays one token, and kinsoku glues closing punctuation
 * to the character before it and opening punctuation to the one after. Spaces and newlines are
 * single tokens, as in Pixi's version. U+00A0 is not a breaking space, so "Apple ID" written
 * with a no-break space stays together.
 */
export function cjkTokenize(text: string): string[] {
  const tokens: string[] = [];
  if (typeof text !== 'string') return tokens;
  let token = '';
  let prev = '';
  for (const ch of text) {
    if (PIXI.TextMetrics.isBreakingSpace(ch) || isNewline(ch)) {
      if (token !== '') tokens.push(token);
      tokens.push(ch);
      token = '';
      prev = '';
      continue;
    }
    if (token !== '' && canBreakBetween(prev, ch)) {
      tokens.push(token);
      token = '';
    }
    token += ch;
    prev = ch;
  }
  if (token !== '') tokens.push(token);
  return tokens;
}

function isNewline(ch: string): boolean {
  return ch === '\n' || ch === '\r';
}

function canBreakBetween(a: string, b: string): boolean {
  if (NO_LINE_START.test(b) || NO_LINE_END.test(a)) return false;
  return FULL_WIDTH.test(a) || FULL_WIDTH.test(b);
}

/**
 * Make every wrapped `PIXI.Text` break Chinese/Japanese/Korean between characters, once at boot.
 *
 * Swaps {@link cjkTokenize} in for `TextMetrics.tokenize` (private in the typings, but it is the
 * static `wordWrap` calls). That is the whole fix: a full-width character is never wider than a
 * line, so Pixi's "fits? else new line" loop fills each line, and `breakWords` keeps its meaning —
 * whether a single Latin word wider than the line may be cut. Text drawn with `wordWrap` off is
 * untouched.
 */
export function installCjkWordWrap(): void {
  (PIXI.TextMetrics as unknown as { tokenize: (text: string) => string[] }).tokenize = cjkTokenize;
}
