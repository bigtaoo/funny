/**
 * isoGrid.ts — 2:1 isometric-diamond projection helpers for WorldMapScene.
 *
 * The world map's logical grid stays plain orthogonal integers `(tx, ty)`
 * (server contracts, pathfinding, tile cache keys — untouched). Only the
 * *screen* projection is isometric: each tile renders as a diamond whose
 * screen-space width is `tileW` and height is `tileW * ISO_RATIO` (classic
 * 2:1 mobile-SLG diamond, e.g. 三国志战略版-style overworld maps).
 *
 * All screen-space helpers here are pan-relative — callers add `panX`/`panY`
 * themselves, matching the existing WorldMapScene convention of keeping pan
 * as a separate world-space pixel offset.
 */

/** Diamond height = width * ISO_RATIO. 0.5 is the standard 2:1 mobile-SLG ratio. */
export const ISO_RATIO = 0.5;

/** Screen-space offset (relative to pan) of tile (tx,ty)'s CENTER — the local drawing origin for that tile. */
export function tileToScreen(tx: number, ty: number, tileW: number): { x: number; y: number } {
  const hw = tileW / 2;
  const hh = (tileW * ISO_RATIO) / 2;
  return { x: (tx - ty) * hw, y: (tx + ty) * hh };
}

/**
 * Inverse of tileToScreen — exact fractional tile coordinates for a pan-relative screen point.
 * Because the projection is a linear (affine) map, `Math.floor` on both components of the
 * result gives the correct containing tile — no special diamond point-in-polygon test needed.
 */
export function screenToTileF(sx: number, sy: number, tileW: number): { x: number; y: number } {
  const hw = tileW / 2;
  const hh = (tileW * ISO_RATIO) / 2;
  const a = sx / hw;
  const b = sy / hh;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Integer tile under a pan-relative screen point. */
export function screenToTile(sx: number, sy: number, tileW: number): { x: number; y: number } {
  const f = screenToTileF(sx, sy, tileW);
  return { x: Math.floor(f.x), y: Math.floor(f.y) };
}

/**
 * Diamond outline (top → right → bottom → left), centered on the tile's local origin.
 * `inset` shrinks the diamond uniformly toward its center (0..~0.49 range) — used for
 * ownership borders / defense-frame insets that used to be `drawRect(pad,pad,tp-2pad,...)`.
 */
export function diamondPath(tileW: number, opts: { inset?: number; tileH?: number } = {}): number[] {
  const inset = opts.inset ?? 0;
  const w = tileW * (1 - inset);
  const h = (opts.tileH ?? tileW * ISO_RATIO) * (1 - inset);
  const hw = w / 2;
  const hh = h / 2;
  return [
    0, -hh,   // top
    hw, 0,    // right
    0, hh,    // bottom
    -hw, 0,   // left
  ];
}

/** The four diamond vertices as points (for edge-midpoint / corner-accent placement). */
export function diamondVertices(tileW: number, tileH: number = tileW * ISO_RATIO): {
  top: [number, number]; right: [number, number]; bottom: [number, number]; left: [number, number];
} {
  const hw = tileW / 2;
  const hh = tileH / 2;
  return { top: [0, -hh], right: [hw, 0], bottom: [0, hh], left: [-hw, 0] };
}

/**
 * Axis-aligned tile-space bounding box covering a pan-relative screen rectangle
 * [0,0]..[screenW,screenH]. Under isometric projection the visible screen rect
 * back-projects to a rotated (diamond) region in tile space, so the covering
 * rectangle is larger than the orthogonal case — pool/viewport sizing must use
 * this instead of naive `screenW / tileW`.
 */
export function visibleTileBounds(
  screenW: number, screenH: number, panX: number, panY: number, tileW: number,
): { minTx: number; maxTx: number; minTy: number; maxTy: number } {
  const corners: [number, number][] = [
    [0, 0], [screenW, 0], [0, screenH], [screenW, screenH],
  ];
  let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
  for (const [sx, sy] of corners) {
    const f = screenToTileF(sx - panX, sy - panY, tileW);
    minTx = Math.min(minTx, f.x); maxTx = Math.max(maxTx, f.x);
    minTy = Math.min(minTy, f.y); maxTy = Math.max(maxTy, f.y);
  }
  return { minTx: Math.floor(minTx), maxTx: Math.ceil(maxTx), minTy: Math.floor(minTy), maxTy: Math.ceil(maxTy) };
}
