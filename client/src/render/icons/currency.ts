/**
 * currency.ts — battle-currency glyph.
 *
 * The coin / coins / coinStack / coinSack / coinChest procedural glyphs that used to live here were
 * removed 2026-08-25: those 5 `IconKind`s now resolve entirely through `TAB_ICON_RASTER` (see
 * icons/tabIconRaster.ts) to the AI-drawn art formerly wrapped by the standalone coinIconAtlas.ts —
 * there is no procedural fallback left for them to draw.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';

/**
 * Ink well — the battle currency ("墨汁"). A squat stationery inkwell half-filled
 * with ink + a drop poised at the rim. `color` tints the liquid + drop (pass the
 * faction blue so it reads as *our* ink). Placeholder until the AI-drawn glyph lands.
 */
export function drawInk(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x1d4);
  const w   = Math.max(1.5, s * 0.055);
  const ink = 0x3a3632; // pencil outline

  // Bottle body (paper-filled so the ink level reads against it).
  const L = s * 0.24, R = s * 0.78, T = s * 0.44, B = s * 0.88;
  g.beginFill(0xf6efdc, 1); g.lineStyle(0);
  g.drawRoundedRect(L, T, R - L, B - T, s * 0.07); g.endFill();
  // Ink level — lower ~55% of the body.
  g.beginFill(color, 0.9); g.lineStyle(0);
  g.drawRoundedRect(L + s * 0.04, T + (B - T) * 0.42, (R - L) - s * 0.08, (B - T) * 0.58 - s * 0.05, s * 0.05);
  g.endFill();
  pen.stroke([
    { x: L, y: T }, { x: L, y: B }, { x: R, y: B }, { x: R, y: T }, { x: L, y: T },
  ], { color: ink, width: w, jitter: 0.4, taper: 0.95, double: false });

  // Neck + rim.
  const nL = s * 0.40, nR = s * 0.62, nT = s * 0.30;
  g.beginFill(0xf6efdc, 1); g.lineStyle(0);
  g.drawRect(nL, nT, nR - nL, T - nT + 1); g.endFill();
  pen.stroke([{ x: nL, y: T }, { x: nL, y: nT }, { x: nR, y: nT }, { x: nR, y: T }],
    { color: ink, width: w * 0.9, jitter: 0.35, taper: 0.9, double: false });
  pen.line(nL - s * 0.05, nT, nR + s * 0.05, nT, { color: ink, width: w, jitter: 0.3, taper: 0.9, double: false });

  // A drop poised above the rim.
  g.beginFill(color, 0.95); g.lineStyle(0);
  g.drawEllipse(s * 0.51, s * 0.17, s * 0.055, s * 0.075);
  g.moveTo(s * 0.51, s * 0.07); g.lineTo(s * 0.565, s * 0.18); g.lineTo(s * 0.455, s * 0.18);
  g.endFill();
}
