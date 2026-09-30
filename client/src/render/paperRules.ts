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
 * copies.
 *
 * On WebGL every window of every ruled line is one quad of ONE mesh, and the red margin rule is a
 * second mesh (ADR-104, 2026-09-29): as sprites a landscape page was 76-86 scene-graph nodes (27
 * lines x 2-3 windows) that the renderer and the change detector (`stageSignature`) walked every
 * frame on every screen; as meshes it is two, drawn from the same atlas at the same vertices and
 * texture coordinates the sprites used. The Canvas fallback keeps the sprites: pixi's canvas mesh
 * renderer draws triangle by triangle and would open seams the sprite path does not have.
 *
 * The atlas is baked at {@link pageBakeResolution} — the device pixels one design unit covers — so a
 * rule line is sampled exactly as densely as the old full-page bake was. It is memoised per
 * resolution: a rotation that changes the on-screen scale gets a new (tiny) atlas.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { bakeLazy, bakeRendererIsCanvas, hasBakeRenderer, pageBakeResolution } from './bake';

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
  /** The whole atlas as one texture, for the meshes (their UVs are atlas-relative). */
  whole: PIXI.Texture;
  /** Mesh geometries by page shape, see {@link geometryFor}. */
  geometries: Map<string, PageGeometry>;
}

interface PageGeometry {
  rules: PIXI.MeshGeometry | null;
  margin: PIXI.MeshGeometry | null;
}

/**
 * Page shapes whose geometry is kept. Scenes rebuild their page on every re-render at the same
 * size, so the hit rate is high; the cap only bounds a window being dragged through many sizes.
 */
const GEOMETRY_CACHE = 24;

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
    whole: new PIXI.Texture(base),
    geometries: new Map(),
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

/** One line of the page: which strip, where, and how far into the strip it starts. */
interface Line {
  strip: PIXI.Texture;
  half: number;
  len: number;
  offset: number;
  at: { cy: number } | { cx: number };
}

/**
 * The windows that cover `len` px of a strip starting `offset` px into it: consecutive
 * `[from, from + take)` slices of the strip, placed end to end at `placed`.
 */
function windows(line: Line, visit: (placed: number, from: number, take: number) => void): void {
  const need = Math.round(line.len);
  let placed = 0;
  while (placed < need) {
    const from = (line.offset + placed) % STRIP;
    const take = Math.min(need - placed, STRIP - from);
    visit(placed, from, take);
    placed += take;
  }
}

/**
 * Canvas path: one sprite per window. Horizontal lines run left to right with the strip's centre
 * line on `cy`; the vertical one is the strip rotated a quarter turn with its centre line on `cx`
 * (same placement maths as panelFrame's vertical edges).
 */
function laySprites(target: PIXI.Container, line: Line, color: number): void {
  const f = line.strip.frame;
  windows(line, (placed, from, take) => {
    const sp = new PIXI.Sprite(new PIXI.Texture(line.strip.baseTexture, new PIXI.Rectangle(f.x + from, f.y, take, f.height)));
    sp.tint = color;
    if ('cy' in line.at) {
      sp.position.set(placed, line.at.cy - line.half);
    } else {
      sp.rotation = Math.PI / 2;
      sp.position.set(line.at.cx + line.half, placed);
    }
    target.addChild(sp);
  });
}

/**
 * WebGL path: the same windows as quads of one geometry. Each quad has exactly the corners and
 * texture coordinates {@link laySprites} gives its sprite — for the vertical rule, the sprite's
 * quarter turn is folded into the corner order (local `(lx, ly)` lands at `(cx + half - ly, placed + lx)`).
 */
function geometryOf(lines: Line[]): PIXI.MeshGeometry | null {
  const verts: number[] = [];
  const uvs: number[] = [];
  for (const line of lines) {
    const f = line.strip.frame;
    const bw = line.strip.baseTexture.width;
    const bh = line.strip.baseTexture.height;
    const v0 = f.y / bh;
    const v1 = (f.y + f.height) / bh;
    windows(line, (placed, from, take) => {
      const u0 = (f.x + from) / bw;
      const u1 = (f.x + from + take) / bw;
      if ('cy' in line.at) {
        const y0 = line.at.cy - line.half;
        const y1 = y0 + f.height;
        verts.push(placed, y0, placed + take, y0, placed + take, y1, placed, y1);
      } else {
        const x0 = line.at.cx + line.half;
        const x1 = x0 - f.height;
        verts.push(x0, placed, x0, placed + take, x1, placed + take, x1, placed);
      }
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    });
  }
  const quads = verts.length / 8;
  if (quads === 0) return null;
  const idx: number[] = [];
  for (let v = 0; v < quads * 4; v += 4) idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  // PIXI's `IArrayBuffer` extends `ArrayBuffer`, which a typed array no longer satisfies under
  // TypeScript's generic typed-array lib; the runtime takes typed arrays as its own examples do.
  const buf = (a: Float32Array | Uint16Array) => a as unknown as PIXI.IArrayBuffer;
  return new PIXI.MeshGeometry(buf(new Float32Array(verts)), buf(new Float32Array(uvs)), buf(new Uint16Array(idx)));
}

/**
 * Geometry for one page shape, memoised on the atlas. Sharing is safe: a mesh's destroy only
 * frees the GPU buffers once no mesh holds the geometry, and a disposed geometry re-uploads from
 * its kept arrays the next time it is drawn.
 */
function geometryFor(s: Strips, key: string, build: () => PageGeometry): PageGeometry {
  let g = s.geometries.get(key);
  if (g) {
    s.geometries.delete(key);   // re-insert: Map order is the LRU order
  } else {
    g = build();
    if (s.geometries.size >= GEOMETRY_CACHE) s.geometries.delete(s.geometries.keys().next().value!);
  }
  s.geometries.set(key, g);
  return g;
}

function mesh(s: Strips, geometry: PIXI.MeshGeometry, color: number): PIXI.Mesh {
  return new PIXI.Mesh(geometry, new PIXI.MeshMaterial(s.whole, { tint: color }));
}

/**
 * Add the page's ruled lines (every `round(h / 28)` px, as before) and, when `marginX` is a number,
 * the red margin rule at that x, into `target`: two meshes on WebGL, one sprite per strip window on
 * Canvas. Returns false when there is no bake renderer (headless tests) — the caller then strokes
 * the page live.
 */
export function addPaperRules(
  target: PIXI.Container, w: number, h: number, marginX: number | null,
  colors: { rule: number; margin: number },
): boolean {
  const s = stripsNow();
  if (!s) return false;
  const r = rng(0x5bd1c7);
  const rules: Line[] = [];
  const lineGap = Math.round(h / 28);
  if (lineGap > 0) {
    for (let y = lineGap; y < h; y += lineGap) {
      const strip = s.rules[Math.floor(r() * RULE_VARIANTS)]!;
      rules.push({ strip, half: RULE_HALF, len: w, offset: Math.floor(r() * STRIP), at: { cy: y } });
    }
  }
  const margin: Line | null = marginX === null ? null
    : { strip: s.margin, half: MARGIN_HALF, len: h, offset: Math.floor(r() * STRIP), at: { cx: Math.round(marginX) } };

  if (bakeRendererIsCanvas()) {
    for (const line of rules) laySprites(target, line, colors.rule);
    if (margin) laySprites(target, margin, colors.margin);
    return true;
  }
  const g = geometryFor(s, `${w}x${h}|${marginX === null ? '-' : Math.round(marginX)}`, () => ({
    rules: geometryOf(rules),
    margin: margin ? geometryOf([margin]) : null,
  }));
  if (g.rules) target.addChild(mesh(s, g.rules, colors.rule));
  if (g.margin) target.addChild(mesh(s, g.margin, colors.margin));
  return true;
}

/** Test seam: forget the memoised atlases (the bake cache itself is reset separately). */
export function resetPaperRules(): void {
  atlases.clear();
}
