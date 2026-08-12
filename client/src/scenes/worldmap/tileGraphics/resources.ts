// tileGraphics/resources — resource motif rendering (per-level heap art + programmatic
// fallback + per-tile placement jitter). Pure PIXI Graphics functions; hold no scene state.
import * as PIXI from 'pixi.js-legacy';
import { getResLevelTexture, getResTexture, isResAtlasReady } from '../../../render/atlas/resAtlasLoader';

// Resource motif size as a fraction of tile pitch `tp`. Shared by the fogged (type-only) and
// revealed (per-level) draw paths so they never diverge in size. Shrunk 0.40→0.30 (2026-07-17):
// with resourceDensity=1.0 a motif sits on EVERY tile, so 0.40 filled each tile edge-to-edge and
// the map read as one uniform carpet of large icons with no visual hierarchy — every tile a
// competing focal point. 0.30 opens real gaps between adjacent motifs so ownership/terrain and
// the high-value tiles can lead the eye. Must stay in lockstep with the map-editor's drawResMotif.
const MOTIF_SIZE_FRAC = 0.30;

/**
 * Render a resource motif sprite onto a tile Graphics.
 *
 * When a hand-drawn `res_{resType}_l{level}` frame exists, draw that real per-level art:
 * the artwork alone carries level/abundance/defense — no programmatic count-replication or
 * pencil defense frames are layered on. All map resTypes now have per-level frames in the atlas
 * (paper/ink/graphite l1–l10 bespoke, metal l1–l10 baked heaps, sticker/copper mine l6–l10 bespoke — sticker
 * only spawns at level ≥6, so it never needs l1–5). Any missing level falls back to the generic
 * `res_{resType}` sprite — deliberately one sprite, no abundance scatter, so the map stays calm.
 *
 * Falls back to a single programmatic shape if the atlas hasn't decoded yet.
 */

export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number, fogged = false, tx = 0, ty = 0): void {
  const lv = Math.max(1, Math.min(10, level));
  // `g`'s local origin is the tile's diamond center (see drawTileL1); the motif sits
  // centred and slightly low, y-offset flattened (×0.6) so it never pokes past the
  // shallower diamond edges near the tile's left/right tips.
  const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];
  const jitter = motifJitter(tx, ty);

  // Outside vision: reveal the resource TYPE only — a single dimmed motif (no level detail,
  // which §18 keeps hidden under fog, same as the level dot).
  if (fogged) {
    if (!isResAtlasReady()) { drawResMotifFallback(g, resType, tp); return; }
    const ftex = getResTexture(resType);
    if (!ftex) return;
    const sp = new PIXI.Sprite(ftex);
    sp.anchor.set(0.5, 0.5);
    // Generic type frame (tall, w<h) — keep max(w,h) so it stays bounded; MOTIF_SIZE_FRAC matches
    // the revealed per-level motif size below so the sprite doesn't jump size when fog clears.
    sp.scale.set((tp * MOTIF_SIZE_FRAC) / Math.max(ftex.width, ftex.height) * jitter.scale);
    sp.rotation = jitter.rot;
    sp.alpha = 0.35;
    [sp.x, sp.y] = toLocal(0.5, 0.52);
    sp.x += jitter.dx * tp; sp.y += jitter.dy * tp;
    g.addChild(sp);
    return;
  }

  // Programmatic fallback while the atlas is still decoding.
  if (!isResAtlasReady()) {
    drawResMotifFallback(g, resType, tp);
    return;
  }

  // Real per-level art when it exists; otherwise a single generic placeholder sprite.
  const levelTex = getResLevelTexture(resType, lv);
  const tex = levelTex ?? getResTexture(resType);
  if (!tex) return;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  // Per-level frames all share the same 128px WIDTH and encode the level in HEIGHT (higher
  // level = taller/denser), so scale them by width — this keeps the per-level height
  // difference instead of normalizing it away via max(w,h). The generic fallback frame
  // (types without per-level art) is TALLER than wide, so it stays on max(w,h) to stay
  // bounded. MOTIF_SIZE_FRAC: shrunk 0.55→0.48→0.40→0.30 to leave clear gaps between adjacent
  // tiles' motifs (resourceDensity=1.0 puts one on every tile), while l1..l10 still read apart.
  const denom = levelTex ? tex.width : Math.max(tex.width, tex.height);
  // Per-tile jitter (2026-07-12, resource-carpet pass): resourceDensity=1.0 puts the SAME
  // resType/level frame on every tile of a biome region, so at real play zoom (L1) identical
  // icons tile in a perfectly uniform grid — reads as a printed stamp pattern, not hand-drawn
  // placement (real-client screenshot at a plain resource patch confirmed this, distinct from
  // the level-alpha "confetti" issue the 2026-07-11 passes already tuned). motifJitter() gives
  // each tile a small deterministic (tx,ty)-hashed offset/rotation/scale, same technique as
  // drawStar's per-vertex wobble — breaks the grid regularity without changing density/alpha/
  // size tuning from those prior passes. Must stay in lockstep with the map-editor's
  // drawResMotif (SLG map render parity).
  sp.scale.set((tp * MOTIF_SIZE_FRAC) / denom * jitter.scale);
  sp.rotation = jitter.rot;
  // Value hierarchy by opacity: with resourceDensity=1.0 a heap sits on EVERY tile, so drawing
  // them all at full strength reads as uniform confetti. Fading low-level heaps (and keeping
  // high-level ones solid) lets the eye pick out the tiles worth fighting for — lv1≈0.65 → lv10=1.0.
  // Floor 0.4→0.65 (2026-07-11) then 0.65→0.55 (2026-07-17): paired with the MOTIF_SIZE_FRAC
  // shrink, a slightly lower floor lets the many low-level tiles recede so the map has a clear
  // value hierarchy again instead of a uniform carpet. Must stay in lockstep with the
  // map-editor's drawResMotif (SLG map render parity).
  sp.alpha = 0.55 + 0.45 * ((lv - 1) / 9);
  [sp.x, sp.y] = toLocal(0.5, 0.52);
  sp.x += jitter.dx * tp; sp.y += jitter.dy * tp;
  g.addChild(sp);
}

/**
 * Deterministic per-tile placement jitter for resource motifs (2026-07-12) — same 2D-hash-of-
 * coordinates technique as drawStar's per-vertex wobble, so identical (tx,ty) always jitters the
 * same way (no shimmer on redraw/pan) without needing a stored seed. `dx`/`dy` are fractions of
 * `tp` (small: ±8%/±6%), `rot` in radians (±~14°), `scale` a multiplier (0.88–1.12). Must stay in
 * lockstep with the map-editor's identical helper (SLG map render parity).
 */
export function motifJitter(tx: number, ty: number): { dx: number; dy: number; rot: number; scale: number } {
  const h1raw = Math.sin(tx * 12.9898 + ty * 78.233) * 43758.5453;
  const h2raw = Math.sin(tx * 39.346 + ty * 11.135) * 24634.6345;
  const h1 = h1raw - Math.floor(h1raw);
  const h2 = h2raw - Math.floor(h2raw);
  return { dx: (h1 - 0.5) * 0.26, dy: (h2 - 0.5) * 0.18, rot: (h1 - 0.5) * 0.7, scale: 0.85 + h2 * 0.3 };
}

/** Single programmatic fallback icon when res_atlas is not yet loaded. Draws one small stationery-themed shape. */

export function drawResMotifFallback(g: PIXI.Graphics, resType: string, tp: number): void {
  const alpha = 0.6;
  const r = tp * 0.12;
  // Center-relative, y flattened to match drawResMotif's diamond-safe placement (`g`'s
  // local origin is the tile's diamond center, not the old square's top-left corner).
  {
    const cx = 0, cy = 0.02 * tp * 0.6;
    g.lineStyle(0);
    if (resType === 'ink') {
      // Ink drop: teardrop shape
      g.beginFill(0x3355aa, alpha);
      g.drawEllipse(cx, cy + r * 0.2, r * 0.65, r * 0.85);
      g.endFill();
      g.beginFill(0x3355aa, alpha);
      g.moveTo(cx, cy - r * 0.9);
      g.lineTo(cx - r * 0.45, cy - r * 0.05);
      g.lineTo(cx + r * 0.45, cy - r * 0.05);
      g.closePath();
      g.endFill();
    } else if (resType === 'paper') {
      // Paper: small rectangle with folded corner
      g.lineStyle(0.8, 0x4477bb, alpha);
      g.beginFill(0xf0ecdd, alpha * 0.9);
      g.drawRect(cx - r * 0.7, cy - r * 0.85, r * 1.4, r * 1.7);
      g.endFill();
      g.lineStyle(0.6, 0x4477bb, alpha * 0.7);
      g.moveTo(cx - r * 0.3, cy - r * 0.85);
      g.lineTo(cx - r * 0.3, cy - r * 0.35);
      g.moveTo(cx - r * 0.3, cy - r * 0.15);
      g.lineTo(cx - r * 0.3, cy + r * 0.55);
      g.lineStyle(0);
    } else if (resType === 'graphite') {
      // Graphite/pencil: elongated hexagon
      g.beginFill(0x778899, alpha);
      g.moveTo(cx, cy - r);
      g.lineTo(cx + r * 0.5, cy - r * 0.5);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.lineTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx - r * 0.5, cy - r * 0.5);
      g.closePath();
      g.endFill();
      g.beginFill(0xccaa44, alpha);
      g.moveTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.closePath();
      g.endFill();
    } else if (resType === 'metal') {
      // Metal: bolt head (circle) + shaft
      g.beginFill(0x889966, alpha);
      g.drawCircle(cx, cy - r * 0.3, r * 0.6);
      g.endFill();
      g.beginFill(0x778855, alpha);
      g.drawRect(cx - r * 0.22, cy + r * 0.2, r * 0.44, r * 0.8);
      g.endFill();
    } else {
      // sticker / default: 5-point star
      g.beginFill(0xcc9922, alpha);
      const pts = 5;
      const outer = r * 0.9, inner = r * 0.4;
      const startAngle = -Math.PI / 2;
      for (let i = 0; i < pts * 2; i++) {
        const angle = startAngle + (i * Math.PI) / pts;
        const rad = i % 2 === 0 ? outer : inner;
        if (i === 0) g.moveTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
        else g.lineTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
      }
      g.closePath();
      g.endFill();
    }
  }
}
