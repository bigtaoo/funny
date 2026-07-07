// ── Outline generation helpers ─────────────────────────────────────────────────
// Hit-flash outline texture generation: a white detached contour band traced just
// outside each bone's silhouette, generated once from the spritesheet bitmap at
// load. See StickmanRuntime / assetLoader for where these feed the outline cache.

import type { SpriteBinding } from './types';

/** Load an HTMLImageElement from a (same-origin / object) URL. */
export function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('outline: spritesheet image load failed'));
    img.src = url;
  });
}

export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Build a white *detached contour line* texture for one bone. The line occupies
 * the band of distance ∈ (gap, gap+width] outside the bone's silhouette — i.e. a
 * `gap`-px transparent margin separates the body from a `width`-px line. Computed
 * as (dilate by gap+width) AND NOT (dilate by gap), each a separable binary
 * box-dilation. RGB is forced white so a per-flash `tint` recolors it.
 *
 * Returns null if the canvas bitmap can't be read (e.g. tainted / headless).
 */
export function buildBoneOutline(
  img: HTMLImageElement,
  sx: number, sy: number, w: number, h: number,
  gap: number, width: number,
  binding: SpriteBinding | undefined,
): { canvas: HTMLCanvasElement; ax: number; ay: number } | null {
  const inner = gap;            // dilation radius to the line's inner edge
  const outer = gap + width;    // dilation radius to the line's outer edge
  const B  = outer + 1;         // canvas margin must hold the full outer ring
  const OW = w + 2 * B;
  const OH = h + 2 * B;

  const canvas = document.createElement('canvas');
  canvas.width  = OW;
  canvas.height = OH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(img, sx, sy, w, h, B, B, w, h);

  let srcData: ImageData;
  try {
    srcData = ctx.getImageData(0, 0, OW, OH);
  } catch {
    return null;  // tainted canvas — skip outline, game still renders
  }

  // Binary coverage mask (alpha ≥ 128) of the bordered source.
  const cov = new Uint8Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) cov[i] = srcData.data[i * 4 + 3] >= 128 ? 1 : 0;

  const innerCov = dilateMask(cov, OW, OH, inner);
  const outerCov = dilateMask(cov, OW, OH, outer);

  const out = ctx.createImageData(OW, OH);
  for (let i = 0; i < OW * OH; i++) {
    // The line = covered by the outer dilation but NOT the inner one.
    if (outerCov[i] && !innerCov[i]) {
      const o = i * 4;
      out.data[o] = 255; out.data[o + 1] = 255; out.data[o + 2] = 255; out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  // The bordered texture moves the bone pivot by B px on each axis; re-normalize
  // the binding anchor to the new (OW × OH) texture so the outline aligns exactly.
  const baseAx = binding?.anchorX ?? 0.5;
  const baseAy = binding?.anchorY ?? 0.5;
  return {
    canvas,
    ax: (baseAx * w + B) / OW,
    ay: (baseAy * h + B) / OH,
  };
}

/** Separable binary dilation (box, radius r) of a 0/1 mask. */
function dilateMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      let hit = 0;
      for (let xx = x0; xx <= x1; xx++) { if (src[row + xx]) { hit = 1; break; } }
      horiz[row + x] = hit;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      let hit = 0;
      for (let yy = y0; yy <= y1; yy++) { if (horiz[yy * w + x]) { hit = 1; break; } }
      out[y * w + x] = hit;
    }
  }
  return out;
}
