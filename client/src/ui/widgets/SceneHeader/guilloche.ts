/**
 * SceneHeader/guilloche.ts — the banknote weave painted under every paper title bar.
 *
 * Split out of SceneHeader.ts (19.08.2026) purely for file length: it is a self-contained curve
 * routine with no dependency on the bar's layout, the back chip, or the title, so it is the first
 * thing the split-priority order (independent function modules first) asks for.
 */
import * as PIXI from 'pixi.js-legacy';

/** Faint guilloche alpha + strand count — approved 07.07.2026 (banknote texture on the paper bar). */
const GUILLOCHE_ALPHA = 0.12;
const GUILLOCHE_STRANDS = 6;

/**
 * Draw the banknote-style guilloche weave into `g`: two mirrored families of
 * phase-shifted compound sine strands, tinted in the category `accent` at a
 * faint alpha so it reads as a premium watermark under the title/back/coins,
 * never competing with them. Amplitude (0.30·h from the mid-line) stays inside
 * the bar, so no clip is needed. Baked once with the rest of the chrome via
 * `getCachedDisplay`, so its cost is paid a single time per cache key.
 * This is the exact curve math signed off in the interactive preview.
 */
export function drawGuilloche(g: PIXI.Graphics, w: number, headerH: number, accent: number): void {
  const mid = headerH / 2;
  const f1 = (2 * Math.PI * 7) / w;
  const f2 = (2 * Math.PI * 11) / w;
  const a1 = headerH * 0.20;
  const a2 = headerH * 0.10;
  g.lineStyle(1, accent, GUILLOCHE_ALPHA);
  for (let fam = 0; fam < 2; fam++) {
    const dir = fam === 0 ? 1 : -1;
    for (let s = 0; s < GUILLOCHE_STRANDS; s++) {
      const ph = (s / GUILLOCHE_STRANDS) * 2 * Math.PI;
      for (let x = 0; x <= w; x += 2) {
        const y = mid + dir * (a1 * Math.sin(f1 * x + ph) + a2 * Math.sin(f2 * x + ph * 1.7));
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
  }
}
