/**
 * panelFrame.ts — the hand-drawn panel border, drawn ONCE into a baked atlas and
 * then assembled per panel out of batched sprites.
 *
 * Why this exists (measured, see design/product/panel-frame-art-prompts.md §0):
 * `sketchPanel` used to stroke a fresh `SketchPen.rect` into a `PIXI.Graphics` on
 * every render. Over the 13 real world-map HUD panel sizes that is 132,300
 * vertices and 8.6 ms of geometry build — and because `GraphicsGeometry`'s
 * `isBatchable()` needs fewer than 100 vertices, every one of those panels forces
 * a `renderer.batch.flush()` plus a direct draw, breaking the batch of whatever
 * is drawn around it too. `WorldMapRenderer` rebuilds that whole set once a
 * second for the march countdowns, so it was ~8.6 ms of pure CPU per second on a
 * dev machine, more on a phone.
 *
 * The fix is to stop rebuilding the geometry: draw long edge strips + corner
 * pieces into one atlas texture at startup, then build each panel from sprite
 * slices of it. Sprites off a single baseTexture batch into one draw call and
 * cost 4 vertices each.
 *
 * Two properties of the old pen are deliberately kept:
 *  - **Wobble amplitude no longer depends on panel size.** A strip window is
 *    pasted at native scale, never stretched, so a 1920px-wide panel wavers by
 *    exactly as much as a 300px one. Amplitude not scaling with size is what made
 *    big panels read as ruler-straight in the first place.
 *  - **`seedFor()` still means something.** It picks each side's window offset
 *    into the strip, so two panels of the same size still differ.
 *
 * The atlas is generated procedurally rather than drawn by an artist: at a 1–3 px
 * frame line there are no pixels for ink pooling or paper fibre, while amplitude
 * and corner radius — the two things that actually matter here — are just numbers
 * in this file. Three rounds of AI source art are recorded in the design doc.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { bakeLazy } from './bake';

/** Stroke weights baked into the atlas; `opts.width` snaps to the nearest. */
const WEIGHTS = [1.2, 2.0, 2.6] as const;

/**
 * Wobble amplitude tiers, chosen by the panel's SHORT side.
 *
 * Amplitude has to be capped against panel height or the border wanders into the
 * content: a 3.6 px waver is a tenth of a 30 px-tall buff row's height, and the
 * top and bottom borders would nearly touch. Small panels therefore get a calmer
 * line — which is also fine visually, because on a small panel a small waver is
 * already a large fraction of the shape.
 */
const TIERS = [
  { maxShortSide: 48,       amp: 1.4, radiusScale: 0.55 },
  { maxShortSide: 120,      amp: 2.4, radiusScale: 0.80 },
  { maxShortSide: Infinity, amp: 3.6, radiusScale: 1.00 },
] as const;

/** Corner radii at `radiusScale: 1`, in order TL, TR, BR, BL. */
const RADII = [5.0, 6.6, 8.0, 6.2] as const;
/** Extra arc (radians) past tangency — the pen "carried past the turn". Two corners only. */
const OVERSHOOT = [0.26, 0, 0.18, 0] as const;

/** Distance between wobble control points. Long enough to read as a hand waver, not a zigzag. */
const WAVE = 26;
/** Length of each edge strip. The wobble loops over it, so tiling it is seamless. */
const STRIP = 1024;
/** Two strips per weight/tier so horizontal and vertical edges don't share a waveform. */
const STRIPS_PER_COMBO = 2;
/** Fine tremble the SketchPen adds on top of the long waver. */
const PEN_JITTER = 0.5;
/** Atlas ink. Irrelevant to the final colour — every slice is tinted at draw time. */
const INK = 0xffffff;

interface ComboGeom {
  width: number;
  amp: number;
  /** Centre-line inset from the panel rect. Ink spans `inset ± (amp + width/2)`. */
  inset: number;
  /** Half-height of a strip row; the strip's centre line sits here. */
  half: number;
  /** Corner cell size (square). Also the per-side inset the corners consume. */
  cell: number;
  radii: [number, number, number, number];
}

function geomFor(weightIdx: number, tierIdx: number): ComboGeom {
  const width = WEIGHTS[weightIdx]!;
  const t = TIERS[tierIdx]!;
  const amp = t.amp;
  // `inset`, `half` and the radii are deliberately WHOLE pixels. Every strip window
  // is positioned from them, and a fractional offset makes each consecutive window
  // sample the atlas at a different subpixel phase — which shows up as a visible
  // step where two windows meet, even though they are adjacent in strip space.
  // The 2.5px term is head-room for what the pen adds on top of `amp`: half the
  // stroke width, PEN_JITTER, and the ghost pass's offset. `half === inset` (rather
  // than inset+1) keeps a strip row exactly `2·inset` tall, so a row pasted with its
  // centre line on the inset lands flush with the panel rect instead of overhanging
  // it by the padding — panels stay exactly `w × h` in bounds.
  const inset = Math.round(amp + width / 2 + 2.5);
  const radii = RADII.map(r => Math.round(r * t.radiusScale)) as [number, number, number, number];
  const cell = Math.ceil(inset + Math.max(...radii) + width / 2 + 2);
  return { width, amp, inset, half: inset, cell, radii };
}

/** Smallest panel side the atlas can frame for this tier (two corner cells must fit). */
export function minFramedSide(weightIdx: number, tierIdx: number): number {
  return geomFor(weightIdx, tierIdx).cell * 2;
}

export function weightIndexFor(width: number): number {
  let best = 0;
  for (let i = 1; i < WEIGHTS.length; i++) {
    if (Math.abs(WEIGHTS[i]! - width) < Math.abs(WEIGHTS[best]! - width)) best = i;
  }
  return best;
}

export function tierIndexFor(w: number, h: number): number {
  const short = Math.min(w, h);
  for (let i = 0; i < TIERS.length; i++) if (short <= TIERS[i]!.maxShortSide) return i;
  return TIERS.length - 1;
}

// ---------------------------------------------------------------------------
// wobble
// ---------------------------------------------------------------------------

/** Small deterministic PRNG — same family as SketchPen's, kept local so seeds don't collide. */
function rng(seed: number): () => number {
  let a = (seed || 1) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Looping 1-D value noise in [-1, 1], smoothstep-interpolated between `n` control
 * points. Looping matters: an edge strip is tiled end-to-end on panels wider than
 * itself, and a non-looping strip would show a step at the wrap.
 */
function loopNoise(seed: number, n: number): (t: number) => number {
  const r = rng(seed);
  const v: number[] = [];
  for (let i = 0; i < n; i++) v.push(r() * 2 - 1);
  return (t: number) => {
    const f = ((t % n) + n) % n;
    const i = Math.floor(f);
    const frac = f - i;
    const s = frac * frac * (3 - 2 * frac);
    return v[i]! * (1 - s) + v[(i + 1) % n]! * s;
  };
}

/** Two octaves: the long waver plus a third of it at a third the wavelength. */
function wobbler(seed: number, n: number): (t: number) => number {
  const a = loopNoise(seed, n);
  const b = loopNoise(seed ^ 0x9e3779b9, n * 3);
  return (t: number) => (a(t) + b(t * 3) * 0.34) / 1.34;
}

// ---------------------------------------------------------------------------
// atlas
// ---------------------------------------------------------------------------

interface Slices {
  /** Horizontal edge strip, `STRIP × (2·half)`, centre line at `half`. */
  edgeH: PIXI.Texture;
  /** Second strip, used for the vertical edges (rotated at draw time). */
  edgeV: PIXI.Texture;
  /** TL, TR, BR, BL corner cells, `cell × cell`. */
  corners: [PIXI.Texture, PIXI.Texture, PIXI.Texture, PIXI.Texture];
  geom: ComboGeom;
}

let atlas: Slices[][] | null = null;
let atlasFailed = false;

/** Lay the atlas out, draw it, bake it, and cut the sub-textures. */
function buildAtlas(): Slices[][] | null {
  // Layout first: strip rows stacked, then one row of 4 corner cells per combo.
  const rows: { wi: number; ti: number; y: number; h: number }[] = [];
  let y = 0;
  for (let wi = 0; wi < WEIGHTS.length; wi++) {
    for (let ti = 0; ti < TIERS.length; ti++) {
      const g = geomFor(wi, ti);
      rows.push({ wi, ti, y, h: g.half * 2 });
      y += g.half * 2 * STRIPS_PER_COMBO;
    }
  }
  const cornerRows: { wi: number; ti: number; y: number }[] = [];
  for (let wi = 0; wi < WEIGHTS.length; wi++) {
    for (let ti = 0; ti < TIERS.length; ti++) {
      cornerRows.push({ wi, ti, y });
      y += geomFor(wi, ti).cell;
    }
  }
  const H = y;

  // Drawing happens inside the bakeLazy closure so it is skipped entirely on a
  // cache hit (and never runs at all without a renderer) — bakeLazy owns the
  // Graphics it is handed and destroys it after rendering.
  const tex = bakeLazy('panelFrameAtlas:v1', () => {
    const gfx = new PIXI.Graphics();
    for (const row of rows) {
      const g = geomFor(row.wi, row.ti);
      for (let s = 0; s < STRIPS_PER_COMBO; s++) {
        drawStrip(gfx, row.y + row.h * s + g.half, g, INK, (row.wi * 3 + row.ti) * 17 + s * 911 + 3);
      }
    }
    for (const row of cornerRows) {
      const g = geomFor(row.wi, row.ti);
      for (let c = 0; c < 4; c++) {
        drawCorner(gfx, c * g.cell, row.y, c, g, INK, (row.wi * 3 + row.ti) * 29 + c * 131 + 7);
      }
    }
    return gfx;
  }, STRIP, H);
  if (!tex) return null;
  const base = tex.baseTexture;
  const out: Slices[][] = [];
  for (let wi = 0; wi < WEIGHTS.length; wi++) out.push([]);
  for (const row of rows) {
    const g = geomFor(row.wi, row.ti);
    const cr = cornerRows.find(r => r.wi === row.wi && r.ti === row.ti)!;
    const sub = (x: number, ry: number, w: number, h: number) =>
      new PIXI.Texture(base, new PIXI.Rectangle(x, ry, w, h));
    out[row.wi]![row.ti] = {
      edgeH: sub(0, row.y, STRIP, g.half * 2),
      edgeV: sub(0, row.y + g.half * 2, STRIP, g.half * 2),
      corners: [0, 1, 2, 3].map(c => sub(c * g.cell, cr.y, g.cell, g.cell)) as Slices['corners'],
      geom: g,
    };
  }
  return out;
}

function slicesFor(weightIdx: number, tierIdx: number): Slices | null {
  if (atlasFailed) return null;
  if (!atlas) {
    atlas = buildAtlas();
    if (!atlas) {
      atlasFailed = true;
      return null;
    }
  }
  return atlas[weightIdx]?.[tierIdx] ?? null;
}

/**
 * Reset the memoised atlas. Only for tests — production bakes once and the
 * `bake()` cache holds the texture for the process lifetime.
 */
export function resetFrameAtlas(): void {
  atlas = null;
  atlasFailed = false;
}

function drawStrip(gfx: PIXI.Graphics, cy: number, g: ComboGeom, color: number, seed: number): void {
  const n = Math.max(4, Math.round(STRIP / WAVE));
  const noise = wobbler(seed, n);
  const pts: { x: number; y: number }[] = [];
  const step = WAVE / 4;
  for (let x = 0; x <= STRIP + 0.01; x += step) {
    pts.push({ x, y: cy + noise((x / STRIP) * n) * g.amp });
  }
  new SketchPen(gfx, seed).stroke(pts, {
    color, width: g.width, jitter: PEN_JITTER, taper: 1,
  });
}

function drawCorner(
  gfx: PIXI.Graphics, ox: number, oy: number, quadrant: number, g: ComboGeom, color: number, seed: number,
): void {
  const r = g.radii[quadrant]!;
  const { inset, cell } = g;
  // Arc centre + sweep per quadrant, in the cell's local frame (panel corner at the
  // cell corner nearest the panel's own corner).
  const near = inset + r, far = cell - inset - r;
  const CENTRES: [number, number][] = [[near, near], [far, near], [far, far], [near, far]];
  const STARTS = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5];
  const [cx, cy] = CENTRES[quadrant]!;
  const a0 = STARTS[quadrant]!;
  const over = OVERSHOOT[quadrant]!;
  const noise = wobbler(seed, 6);
  const steps = Math.max(6, Math.round(r * 1.6));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 - over * 0.5 + (Math.PI / 2 + over) * t;
    const rr = r + noise(t * 5) * g.amp * 0.5;
    pts.push({ x: ox + cx + Math.cos(a) * rr, y: oy + cy + Math.sin(a) * rr });
  }
  new SketchPen(gfx, seed).stroke(pts, {
    color, width: g.width, jitter: PEN_JITTER, taper: 1,
  });
}

// ---------------------------------------------------------------------------
// per-panel assembly
// ---------------------------------------------------------------------------

/**
 * Add the frame for a `w × h` panel into `target`. Returns false when the atlas
 * is unavailable (no bake renderer — headless tests) or the panel is too small to
 * seat two corner cells; the caller then falls back to the live SketchPen path.
 */
export function addPanelFrame(
  target: PIXI.Container, panelW: number, panelH: number, color: number, width: number, seed: number,
): boolean {
  const wi = weightIndexFor(width);
  const ti = tierIndexFor(panelW, panelH);
  const s = slicesFor(wi, ti);
  if (!s) return false;
  const g = s.geom;
  if (panelW < g.cell * 2 || panelH < g.cell * 2) return false;
  // Panel sizes are often fractions of the screen. Snap the FRAME to whole pixels
  // (the fill Graphics keeps the exact size — a half-pixel fill edge is invisible,
  // a half-pixel texture offset is not; see geomFor).
  const w = Math.round(panelW), h = Math.round(panelH);

  const r = rng(seed || 1);
  const pick = () => Math.floor(r() * STRIP);
  const [rTL, rTR, rBR, rBL] = g.radii;

  // Corners.
  const at = (tex: PIXI.Texture, x: number, y: number) => {
    const sp = new PIXI.Sprite(tex);
    sp.position.set(x, y);
    sp.tint = color;
    target.addChild(sp);
  };
  at(s.corners[0], 0, 0);
  at(s.corners[1], w - g.cell, 0);
  at(s.corners[2], w - g.cell, h - g.cell);
  at(s.corners[3], 0, h - g.cell);

  // Edges: consecutive windows of the strip, laid in reading order so the joins
  // are just "carry on along the same line". The strip's wobble loops, so the
  // wrap at its end is seamless too.
  const run = (
    tex: PIXI.Texture, fromRaw: number, toRaw: number, offset: number, vertical: boolean, side: 0 | 1,
  ) => {
    // Integer bounds so every window lands on a whole pixel (see geomFor).
    const from = Math.round(fromRaw);
    const need = Math.round(toRaw) - from;
    let placed = 0;
    if (need <= 0) return;
    while (placed < need) {
      const at0 = (offset + placed) % STRIP;
      const take = Math.min(need - placed, STRIP - at0);
      const frame = tex.frame;
      const win = new PIXI.Texture(
        tex.baseTexture,
        new PIXI.Rectangle(frame.x + at0, frame.y, take, frame.height),
      );
      const sp = new PIXI.Sprite(win);
      sp.tint = color;
      if (vertical) {
        // Rotated a quarter turn, anchor at (0,0): a local point (lx, ly) lands at
        // (pos.x - ly, pos.y + lx). So `lx` runs down the edge (pos.y is the start),
        // and the strip's centre line (local y = half) lands at `pos.x - half` —
        // hence pos.x = <target centre x> + half.
        sp.rotation = Math.PI / 2;
        sp.position.set((side === 0 ? g.inset : w - g.inset) + g.half, from + placed);
      } else {
        sp.position.set(from + placed, (side === 0 ? g.inset : h - g.inset) - g.half);
      }
      target.addChild(sp);
      placed += take;
    }
  };
  run(s.edgeH, g.inset + rTL, w - g.inset - rTR, pick(), false, 0);
  run(s.edgeH, g.inset + rBL, w - g.inset - rBR, pick(), false, 1);
  run(s.edgeV, g.inset + rTL, h - g.inset - rBL, pick(), true, 0);
  run(s.edgeV, g.inset + rTR, h - g.inset - rBR, pick(), true, 1);
  return true;
}
