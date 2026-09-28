/**
 * paperRules.ts — the notebook page's ruled lines and red margin rule, drawn ONCE into a small
 * baked strip atlas and laid out per page as batched sprites.
 *
 * Why (2026-09-28 first-visit probe, `claudedocs/client-render-budget.md` §19): `buildPaperBackground`
 * used to stroke ~28 page-wide `SketchPen` lines and bake the result into one full-page
 * RenderTexture per `(w, h, rule x)`. Every stroke is ~one round-capped segment per 10 px, so a page
 * is several hundred thousand indices that PIXI triangulates inside the bake render: 20-27 ms per
 * new key on a desktop, and a modal of a new size, a screen with a wider tab rail or the map's
 * rule-less page each minted a new key — the first open of Settings, Gacha, the world map, Feedback,
 * a result screen or a city modal each paid it again (defense editor and the train modal twice,
 * 54-67 ms). Each key was also a full backbuffer of GPU memory kept for the whole session.
 *
 * The strips are the same pen with the same parameters, but only 1024 px long and drawn once: a
 * page lays consecutive windows of a strip end to end (the pen's endpoints barely move, so the wrap
 * is seamless at this 0.7 px jitter), and a seeded offset per line keeps two lines from reading as
 * copies. Sprites off one base texture batch into one draw call.
 *
 * The atlas is baked at {@link pageBakeResolution} — the device pixels one design unit covers — so a
 * rule line is sampled exactly as densely as the old full-page bake was. It is memoised per
 * resolution: a rotation that changes the on-screen scale gets a new (tiny) atlas.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { bakeLazy, hasBakeRenderer, pageBakeResolution } from './bake';

/** Strip length. Long enough that a phone-width page is one or two windows per line. */
const STRIP = 1024;
/** Distinct ruled-line waveforms; each page line picks one, plus an offset into it. */
const RULE_VARIANTS = 4;
/** Atlas ink. Every sprite is tinted at draw time. */
const INK = 0xffffff;

/** The two pens, exactly as `buildPaperBackground` stroked them live (minus the end taper, see below). */
const RULE = { width: 1.1, jitter: 0.7, double: false };
const MARGIN = { width: 2.2, jitter: 1.0, double: true };

/**
 * Half-height of a strip row: stroke half-width + jitter + the ghost pass's offset
 * (`pen.doubleOffset` 0.9) + a pixel of head-room, rounded up so windows land on whole pixels.
 */
const RULE_HALF = Math.ceil(RULE.width / 2 + RULE.jitter + 1.5);
const MARGIN_HALF = Math.ceil(MARGIN.width / 2 + MARGIN.jitter + 0.9 + 1.5);

interface Strips {
  rules: PIXI.Texture[];
  margin: PIXI.Texture;
}

const atlases = new Map<number, Strips>();

function buildAtlas(): Strips | null {
  const ruleH = RULE_HALF * 2;
  const H = ruleH * RULE_VARIANTS + MARGIN_HALF * 2;
  const tex = bakeLazy('paperRules:v1', () => {
    const g = new PIXI.Graphics();
    // The live page tapered each line to 0.9x / 0.95x at its two ends. A strip has no ends on the
    // page (windows run edge to edge), so it is drawn untapered: the taper only ever reached the
    // outermost ~10% of a line, i.e. under the tab rail and past the right edge of the content.
    for (let i = 0; i < RULE_VARIANTS; i++) {
      new SketchPen(g, 0x5bd1c7 + i * 977).line(0, ruleH * i + RULE_HALF, STRIP, ruleH * i + RULE_HALF, {
        color: INK, width: RULE.width, jitter: RULE.jitter, taper: 1, double: RULE.double,
      });
    }
    const my = ruleH * RULE_VARIANTS + MARGIN_HALF;
    new SketchPen(g, 0x5bd1c7 ^ 0x2f).line(0, my, STRIP, my, {
      color: INK, width: MARGIN.width, jitter: MARGIN.jitter, taper: 1, double: MARGIN.double,
    });
    return g;
  }, STRIP, H, { pageScale: true });
  if (!tex) return null;
  const base = tex.baseTexture;
  const sub = (y: number, h: number) => new PIXI.Texture(base, new PIXI.Rectangle(0, y, STRIP, h));
  return {
    rules: Array.from({ length: RULE_VARIANTS }, (_, i) => sub(ruleH * i, ruleH)),
    margin: sub(ruleH * RULE_VARIANTS, MARGIN_HALF * 2),
  };
}

function stripsNow(): Strips | null {
  if (!hasBakeRenderer()) return null;
  const res = pageBakeResolution();
  let s = atlases.get(res);
  if (!s) {
    const built = buildAtlas();
    if (!built) return null;
    atlases.set(res, built);
    s = built;
  }
  return s;
}

/** Small deterministic PRNG for window offsets (visual only). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lay `len` px of `strip` along one line, starting `offset` px into the strip. Horizontal lines run
 * left to right with the strip's centre line on `cy`; the vertical one is the strip rotated a
 * quarter turn with its centre line on `cx` (same placement maths as panelFrame's vertical edges).
 */
function lay(
  target: PIXI.Container, strip: PIXI.Texture, half: number, len: number, offset: number,
  color: number, at: { cy: number } | { cx: number },
): void {
  const need = Math.round(len);
  let placed = 0;
  while (placed < need) {
    const from = (offset + placed) % STRIP;
    const take = Math.min(need - placed, STRIP - from);
    const f = strip.frame;
    const sp = new PIXI.Sprite(new PIXI.Texture(strip.baseTexture, new PIXI.Rectangle(f.x + from, f.y, take, f.height)));
    sp.tint = color;
    if ('cy' in at) {
      sp.position.set(placed, at.cy - half);
    } else {
      sp.rotation = Math.PI / 2;
      sp.position.set(at.cx + half, placed);
    }
    target.addChild(sp);
    placed += take;
  }
}

/**
 * Add the page's ruled lines (every `round(h / 28)` px, as before) and, when `marginX` is a number,
 * the red margin rule at that x, into `target`. Returns false when there is no bake renderer
 * (headless tests) — the caller then strokes the page live.
 */
export function addPaperRules(
  target: PIXI.Container, w: number, h: number, marginX: number | null,
  colors: { rule: number; margin: number },
): boolean {
  const s = stripsNow();
  if (!s) return false;
  const r = rng(0x5bd1c7);
  const lineGap = Math.round(h / 28);
  if (lineGap > 0) {
    for (let y = lineGap; y < h; y += lineGap) {
      const variant = s.rules[Math.floor(r() * RULE_VARIANTS)]!;
      lay(target, variant, RULE_HALF, w, Math.floor(r() * STRIP), colors.rule, { cy: y });
    }
  }
  if (marginX !== null) {
    lay(target, s.margin, MARGIN_HALF, h, Math.floor(r() * STRIP), colors.margin, { cx: Math.round(marginX) });
  }
  return true;
}

/** Test seam: forget the memoised atlases (the bake cache itself is reset separately). */
export function resetPaperRules(): void {
  atlases.clear();
}
