// HUDView's HP-bar rendering (heart-pip cells + the critical-HP warning glyph), extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). Pure given a
// PIXI.Graphics + its params — no host object needed, HUDView.sync() just calls drawHpBar directly.
import * as PIXI from 'pixi.js-legacy';

const HP_CELLS    = 10;
const HP_CELL_W   = 21;
const HP_CELL_GAP = 3;
export const HP_BAR_W = HP_CELLS * (HP_CELL_W + HP_CELL_GAP) - HP_CELL_GAP;

/** Parametric heart outline (same curve as icons/equipment.ts drawHp), as plain points for fill/clip. */
export function heartPoints(s: number): { x: number; y: number }[] {
  const cx = s / 2, cy = s * 0.46, k = s * 0.025;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const tt = (Math.PI * 2 * i) / 24;
    const hx = 16 * Math.pow(Math.sin(tt), 3);
    const hy = 13 * Math.cos(tt) - 5 * Math.cos(2 * tt) - 2 * Math.cos(3 * tt) - Math.cos(4 * tt);
    pts.push({ x: cx + hx * k, y: cy - hy * k });
  }
  return pts;
}

/** Sutherland–Hodgman clip of a closed polygon to the half-plane x <= clipX. */
export function clipPolygonRight(pts: { x: number; y: number }[], clipX: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const cur = pts[i]!, prev = pts[(i - 1 + n) % n]!;
    const curIn = cur.x <= clipX, prevIn = prev.x <= clipX;
    if (curIn !== prevIn) {
      const t = (clipX - prev.x) / (cur.x - prev.x);
      out.push({ x: clipX, y: prev.y + t * (cur.y - prev.y) });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/**
 * HP bar in the faction hue (us = blue, enemy = red). Danger is signalled by the
 * filled cells *blinking* (alpha throb) — never by changing hue — so our low-HP
 * alarm can't be mistaken for the enemy's red. Two tiers:
 *   low      (≤3 cells): gentle blink on `pulse`.
 *   critical (last cell): urgent fast blink on `pulseFast` + an amber ⚠ above the
 *     bar. The last cell is the "one haste-rush from over" moment for BOTH bases,
 *     so the enemy bar escalates too (it also gets a base-ring on the board).
 *
 * Each cell is a heart (not a plain rect): the boundary heart fills left-to-right
 * by HP fraction (e.g. one third gray) instead of snapping fully on/off, so partial
 * HP within a pip is visible. Hearts are re-clipped every call (blink alpha animates
 * continuously) so the shape must stay jitter-free — no SketchPen here.
 */
export function drawHpBar(
  gfx: PIXI.Graphics, hp: number, maxHp: number, color: number, pulse: number, pulseFast: number,
): void {
  gfx.clear();
  const totalFrac = Math.max(0, hp / maxHp) * HP_CELLS;
  const filledFull = Math.floor(totalFrac);
  const partial     = totalFrac - filledFull;
  const filledCeil  = Math.ceil(totalFrac);
  const critical = hp > 0 && filledCeil <= 1;
  const low      = hp > 0 && filledCeil <= 3 && !critical;
  const fillAlpha = critical ? 0.25 + 0.75 * pulseFast : low ? 0.35 + 0.6 * pulse : 0.9;
  for (let i = 0; i < HP_CELLS; i++) {
    const frac = i < filledFull ? 1 : i === filledFull ? partial : 0;
    drawHeartPip(gfx, i * (HP_CELL_W + HP_CELL_GAP), frac, color, fillAlpha);
  }
  if (critical) drawHpWarning(gfx, pulseFast);
}

/** A single heart-shaped HP pip, filled left-to-right by `frac` (0..1). */
function drawHeartPip(gfx: PIXI.Graphics, x: number, frac: number, color: number, alpha: number): void {
  const pts = heartPoints(HP_CELL_W);
  gfx.lineStyle(1, 0x888888, 0.4);
  gfx.beginFill(0xdddddd, 0.4);
  gfx.drawPolygon(pts.map(p => new PIXI.Point(x + p.x, p.y)));
  gfx.endFill();
  if (frac <= 0) return;
  const clipped = frac >= 1 ? pts : clipPolygonRight(pts, frac * HP_CELL_W);
  if (clipped.length < 3) return;
  gfx.lineStyle(frac >= 1 ? 1 : 0, 0x888888, 0.4);
  gfx.beginFill(color, alpha);
  gfx.drawPolygon(clipped.map(p => new PIXI.Point(x + p.x, p.y)));
  gfx.endFill();
}

/** Amber ⚠ centred above the bar, blinking on `pulseFast` — the critical-HP alarm. */
function drawHpWarning(gfx: PIXI.Graphics, pulseFast: number): void {
  const cx = HP_BAR_W / 2;
  const tw = 16, th = 13, topY = -th - 4;
  const a = 0.4 + 0.6 * pulseFast;
  gfx.beginFill(0xffb300, a);
  gfx.moveTo(cx, topY);
  gfx.lineTo(cx - tw / 2, topY + th);
  gfx.lineTo(cx + tw / 2, topY + th);
  gfx.closePath();
  gfx.endFill();
  gfx.beginFill(0x4a3200, a); // the "!" inside
  gfx.drawRect(cx - 1, topY + 3, 2, th - 7);
  gfx.drawRect(cx - 1, topY + th - 3, 2, 2);
  gfx.endFill();
}
