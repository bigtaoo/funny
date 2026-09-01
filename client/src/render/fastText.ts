/**
 * fastText.ts — text nodes whose *re*-creation is free.
 *
 * Why this exists (measured, see design/game/CHARACTER_CARDS_DESIGN_IMPL.md §10.5):
 * every `PIXI.Text` owns a private canvas. Constructing one runs `measureText` +
 * `fillText` into that canvas, and the first draw uploads it to the GPU as its own
 * `BaseTexture`. On the Hero Roster that is 7 texts per visible cell — 105 for a
 * 15-cell grid — and `CardScene.render()` used to tear all of them down and mint
 * them again on **every scroll frame**. Benchmarked in Chrome at dpr 1: ~11 ms per
 * frame for the rasterize + upload alone, before any drawing.
 *
 * The fix has two halves, mirroring the two kinds of string a game UI actually draws:
 *
 *  - **{@link cachedTxt}** — for strings from a *bounded* set: i18n labels, card
 *    names, slot names. Rasterize once per (string, size, colour, weight), keep the
 *    resulting texture, and hand out `PIXI.Sprite`s of it forever after. Bounded is
 *    the load-bearing word — the cache is LRU-capped ({@link CACHE_CAP}) and evicted
 *    entries are destroyed, so an accidental unbounded key set degrades to "as slow
 *    as before" rather than to a leak.
 *  - **{@link numTxt}** — for *unbounded* strings that are all digits and ASCII
 *    punctuation: counters, `cur/cap` readouts, prices. Every glyph is rasterized once
 *    into one small atlas per (size, weight, colour) and a number is assembled as one
 *    `Sprite` per character off that single `BaseTexture`. Nothing is rasterized per
 *    value, and because the sprites share a base texture they batch into the same draw
 *    call as the panel frames around them (see {@link ./panelFrame}).
 *
 * Both reproduce `txt()`'s output, including the CJK anti-clip padding from
 * {@link ./pixiText}, by reusing PIXI's own `PIXI.Text` rasterizations rather than
 * re-deriving font metrics: `cachedTxt` keeps the whole `Text` and hands out Sprites of
 * its texture, `numTxt` blits one `Text` per glyph into a shared canvas and copies the
 * reference glyph's `frame`/`trim`/`orig` onto every slice. Verified in the browser at
 * 3x device pixels: identical glyph positions, ink within 0.03% (2026-08-24). Nothing
 * here changes layout, so a call site converts by swapping the function name.
 *
 * Not usable for: anything that needs `.style` after construction (word wrap), an
 * `.anchor` on the `numTxt` path (it returns a plain `Container`), or `PIXI.Text`'s
 * `resolution` trick for content inside a scaled-up modal (see `scaledTxt`) — the
 * modal's scale is a viewport-dependent float, so caching per (string, scale) would
 * be unbounded by construction. Those keep using `txt()`/`stxt()`.
 *
 * Teardown contract: the returned nodes are `Sprite`/`Container`, so
 * `tearDownChildren`'s default `texture: false` leaves the cached textures alone —
 * exactly as it already does for the `bake()`-backed paper background. Only
 * {@link resetFastTextCaches} (tests) and LRU eviction ever destroy one.
 */
import * as PIXI from 'pixi.js-legacy';
import { baseTextureFromCanvas } from './canvasTexture';
import { bakeResolution, hasBakeRenderer } from './bake';
import { txt } from './sketchUi';

/**
 * Largest number of distinct (string, size, colour, weight) combinations kept
 * rasterized. Sized for "every label + every card name + every slot name, in one
 * language, several colours" with room to spare; the roster uses ~60.
 */
const CACHE_CAP = 320;

/** Characters {@link numTxt} can assemble from an atlas. Space is an advance, not a glyph. */
const NUM_CHARS = '0123456789/+-.,:%()[]';
/** Characters in the reference run the monospace advance is averaged over — see buildGlyphAtlas. */
const ADVANCE_PROBE = 32;

/**
 * Insertion-ordered → iteration order is LRU order (re-`set` on hit moves to the end).
 *
 * Holds the `PIXI.Text` itself, not just its texture, and that is deliberate: `Text.destroy()`
 * ends with `this._ownCanvas && (this.canvas.height = this.canvas.width = 0)`, i.e. it wipes the
 * glyph canvas the texture is backed by even when told `texture: false`. Adopting the texture and
 * dropping the Text therefore uploads an empty bitmap — every cached label rendered as a solid
 * black box (caught in the browser, 2026-08-24). Keeping the Text alive as the canvas's owner costs
 * one small object per entry and keeps `frame`/`trim`/`orig` exactly as PIXI computed them.
 */
const textCache = new Map<string, PIXI.Text>();

/**
 * Rasterize-once text for a **bounded** set of strings — see the module header for
 * what "bounded" has to mean. Returns a `PIXI.Sprite` of the cached texture, which
 * lays out identically to the `txt()` it replaces.
 *
 * Falls back to a live `PIXI.Text` when no bake renderer is wired (headless tests):
 * with no GPU there are no uploads to save, and callers/tests that walk the tree for
 * `PIXI.Text` keep working.
 */
export function cachedTxt(
  label: string, size: number, color: number, bold = false,
): PIXI.Sprite | PIXI.Text {
  if (!hasBakeRenderer()) return txt(label, size, color, bold);

  const key = `${bold ? 'b' : 'r'}|${size}|${(color >>> 0).toString(16)}|${label}`;
  const hit = textCache.get(key);
  if (hit) {
    textCache.delete(key);
    textCache.set(key, hit);   // touch: move to the LRU tail
    return new PIXI.Sprite(hit.texture);
  }

  const t = txt(label, size, color, bold);
  // PIXI.Text normally samples the renderer's resolution at *render* time (`_autoResolution`).
  // This one is never rendered — it only exists to own a rasterized canvas — so stamp the
  // resolution up front or the glyph canvas is built at settings.RESOLUTION and comes out soft on
  // a HiDPI renderer.
  t.resolution = bakeResolution();
  t.updateText(false);

  textCache.set(key, t);
  if (textCache.size > CACHE_CAP) {
    const oldest = textCache.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      textCache.get(oldest)?.destroy({ texture: true, baseTexture: true });
      textCache.delete(oldest);
    }
  }
  // The Text's own texture carries pixiText's anti-clip padding in frame/trim/orig, so a Sprite of
  // it lands exactly where the Text would have.
  return new PIXI.Sprite(t.texture);
}

interface GlyphAtlas {
  /**
   * Sub-texture per character of {@link NUM_CHARS}, keyed by the character. Each carries the
   * reference glyph's `orig`/`trim`, so a Sprite of one sits exactly where a `PIXI.Text` of that
   * character would — including pixiText's anti-clip padding.
   */
  glyphs: Map<string, PIXI.Texture>;
  /** Monospace advance width (px) — one value for every glyph, by definition. */
  advance: number;
  /** `size|weight` — the part of the key the advance depends on; see {@link numAdvance}. */
  metricKey: string;
}

const atlases = new Map<string, GlyphAtlas | null>();

/**
 * Number/counter text assembled from a baked glyph atlas — free to re-create, and
 * batched with the surrounding sprites. Accepts only {@link NUM_CHARS} plus spaces;
 * anything else (a translated word, CJK) falls back to a live `PIXI.Text`, so it is
 * safe to call on a string that only *usually* looks numeric.
 *
 * Returns a `PIXI.Container` of glyph sprites, so `.anchor` is not available — a caller that needs
 * to right-align or centre one multiplies {@link numAdvance} by the character count.
 */
export function numTxt(
  label: string, size: number, color: number, bold = false,
): PIXI.Container | PIXI.Text {
  const atlas = numericOnly(label) ? glyphAtlas(size, bold, color) : null;
  if (!atlas) return txt(label, size, color, bold);

  const c = new PIXI.Container();
  for (let i = 0; i < label.length; i++) {
    const tex = atlas.glyphs.get(label[i]!);
    if (!tex) continue;   // space
    const sp = new PIXI.Sprite(tex);
    // Offsets stay fractional (`advance` is the font's true advance — 9.6 for monospace-16 — and
    // canvas `fillText` steps by exactly that), but `roundPixels` snaps each glyph to a whole DEVICE
    // pixel at draw time — design-space rounding cannot, because the design→device scale is a
    // runtime float. Same trick PIXI's own BitmapText uses.
    sp.position.set(i * atlas.advance, 0);
    sp.roundPixels = true;
    c.addChild(sp);
  }
  return c;
}

/**
 * Monospace advance width for one character at (size, weight) — the step {@link numTxt} lays glyphs
 * out on, and therefore also the width of the single space in a `"<label> <value>"` line. Exact from
 * the atlas; measured (and memoised) when there is no atlas to read it off.
 */
export function numAdvance(size: number, bold = false): number {
  const key = `${size}|${bold ? 'b' : 'r'}`;
  // The advance is a font metric, identical across atlas colours, so any already-built atlas of this
  // (size, weight) answers. Deliberately does not BUILD one: a layout helper has no business
  // deciding which colour gets rasterized.
  for (const atlas of atlases.values()) if (atlas?.metricKey === key) return atlas.advance;
  const memo = advanceFallback.get(key);
  if (memo !== undefined) return memo;
  // Same reference-run measurement as buildGlyphAtlas, for the same reason — see there.
  const t = txt('0'.repeat(ADVANCE_PROBE), size, 0, bold);
  const w = t.width / ADVANCE_PROBE;
  t.destroy({ texture: true, baseTexture: true });
  advanceFallback.set(key, w);
  return w;
}

const advanceFallback = new Map<string, number>();

function numericOnly(label: string): boolean {
  for (const ch of label) if (ch !== ' ' && !NUM_CHARS.includes(ch)) return false;
  return true;
}

/**
 * The glyph atlas for one (size, weight), built on first use and memoised for the process. Null
 * when there is no bake renderer wired — which is this module's proxy for "no real canvas either"
 * (the headless test adapter fakes `measureText` but rasterizes nothing), so callers fall back to
 * live text and the `*.ui.ts` suites keep seeing `PIXI.Text` nodes.
 */
function glyphAtlas(size: number, bold: boolean, color: number): GlyphAtlas | null {
  const key = `${size}|${bold ? 'b' : 'r'}|${(color >>> 0).toString(16)}`;
  const memo = atlases.get(key);
  if (memo !== undefined) return memo;

  const built = buildGlyphAtlas(size, bold, color);
  atlases.set(key, built);
  return built;
}

/**
 * Rasterize one `PIXI.Text` per {@link NUM_CHARS} character and **blit their canvases side by side
 * into a single canvas**, then cut one sub-texture per glyph out of it.
 *
 * Blitting the Texts' own canvases (rather than drawing the glyphs into a `RenderTexture` via
 * `bake()`) keeps one texture sampling between the glyph canvas and the screen instead of two:
 * `drawImage` at whole *device* pixel offsets is a straight copy, so the pixels that reach the
 * screen are byte-for-byte the ones PIXI produced. It also drops the atlas's dependency on a live
 * renderer down to a dependency on a working canvas.
 *
 * Glyphs are rasterized in the FINAL colour, one atlas per (size, weight, colour) — not once in
 * white and tinted per use. Tinting would be the obvious way to get one atlas for all colours, and
 * it is wrong here: Chrome gamma-corrects glyph antialiasing against the fill colour, so a white
 * glyph multiplied down to ink-grey comes out visibly heavier than the same glyph filled grey (~11%
 * more ink on a 6x crop, measured 2026-08-24). The colour count is small and bounded by design —
 * the roster uses three — and numbers sharing a colour still batch together.
 */
function buildGlyphAtlas(size: number, bold: boolean, color: number): GlyphAtlas | null {
  if (!hasBakeRenderer()) return null;
  const resolution = bakeResolution();

  // Measure the advance off a reference RUN, not a single glyph: `PIXI.Text.width` is its glyph
  // canvas width, ceil()'d to whole pixels, so a one-character probe reports 10 where monospace-16's
  // true advance is 9.6 — and a 7-digit counter laid out on that rounded step came out ~3 device px
  // wider than the PIXI.Text it replaced (measured, 2026-08-24). Averaging over ADVANCE_PROBE
  // characters pushes the ceil error below a thirtieth of a pixel.
  const probe = txt('0'.repeat(ADVANCE_PROBE), size, color, bold);
  probe.resolution = resolution;
  const advance = probe.width / ADVANCE_PROBE;
  probe.destroy({ texture: true, baseTexture: true });
  if (!(advance > 0)) return null;

  const chars = [...NUM_CHARS];
  const glyphTexts = chars.map((ch) => {
    const t = txt(ch, size, color, bold);
    t.resolution = resolution;
    t.updateText(false);
    return t;
  });
  const release = (): void => {
    for (const t of glyphTexts) t.destroy({ texture: true, baseTexture: true });
  };
  const ref = glyphTexts[0]!;
  // Monospace, one style → every glyph canvas comes out the same size, but take the max rather than
  // trusting that: a font fallback for one odd character would otherwise clip it.
  const cellW = Math.max(...glyphTexts.map((t) => t.canvas.width));
  const cellH = Math.max(...glyphTexts.map((t) => t.canvas.height));
  if (!(cellW > 0) || !(cellH > 0)) { release(); return null; }

  // ADAPTER, not `document`: WeChat has no DOM, and the headless test adapter hooks the same seam.
  const atlasCanvas = PIXI.settings.ADAPTER.createCanvas(cellW * chars.length, cellH);
  const ctx = atlasCanvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) { release(); return null; }
  glyphTexts.forEach((t, i) => ctx.drawImage(t.canvas as CanvasImageSource, i * cellW, 0));

  // 指名 CanvasResource，不靠 instanceof 嗅探（微信没有 HTMLCanvasElement 全局）——见 canvasTexture.ts。
  const base = baseTextureFromCanvas(atlasCanvas, {
    resolution,
    scaleMode: ref.texture.baseTexture.scaleMode,
  });
  // Frames are in logical units; orig/trim are copied off the reference glyph so each sprite
  // inherits PIXI's own padding compensation verbatim.
  const frameW = cellW / resolution;
  const frameH = cellH / resolution;
  const orig = ref.texture.orig.clone();
  const trim = ref.texture.trim ? ref.texture.trim.clone() : undefined;
  const glyphs = new Map<string, PIXI.Texture>();
  chars.forEach((ch, i) => {
    glyphs.set(ch, new PIXI.Texture(
      base, new PIXI.Rectangle(i * frameW, 0, frameW, frameH), orig.clone(), trim?.clone(),
    ));
  });
  // Safe now that the pixels have been copied out — Text.destroy() zeroes its own canvas.
  release();
  return { glyphs, advance, metricKey: `${size}|${bold ? 'b' : 'r'}` };
}

/**
 * Drop every cached texture and atlas. Tests only — production rasterizes each
 * string at most once and keeps it for the process lifetime.
 */
export function resetFastTextCaches(): void {
  for (const t of textCache.values()) t.destroy({ texture: true, baseTexture: true });
  textCache.clear();
  atlases.clear();
  advanceFallback.clear();
}

/** Number of rasterized strings currently held. Tests / diagnostics. */
export function fastTextCacheSize(): number {
  return textCache.size;
}
