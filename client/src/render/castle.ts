/**
 * castle.ts — procedural hand-drawn base castle (art direction §6.3).
 *
 * Replaces the `game_base.png` bitmap with a simple-line castle a kid would
 * doodle: a crenellated wall, a gate arch, and a little pennant. Drawn with the
 * shared SketchPen in faction ink (blue = us / red = enemy) + pencil structure
 * lines, then baked per (size, side) so it costs nothing per frame. Sits in a
 * 2×2 board cell; cracks accumulate on a separate live layer (BoardView).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { palette, factionInk } from './theme';
import { Side } from '../game/types';
import { bake } from './bake';

/**
 * Build a castle sprite sized `w × h` for the given faction side. Returns a
 * baked Sprite (cached per size/side) anchored at its center, or live Graphics
 * headless. Caller positions it; mirroring is unnecessary (the doodle reads the
 * same both ways — the ink color carries the faction).
 */
export function buildCastle(w: number, h: number, side: Side): PIXI.Sprite | PIXI.Graphics {
  const ink = side === Side.Top ? factionInk.enemy : factionInk.friend;
  const g   = new PIXI.Graphics();
  const pen = new SketchPen(g, side === Side.Top ? 0xc0ffee : 0xb1ec0d);

  // Paper-tinted body so the castle reads as a filled shape, faction ink lines.
  const m   = Math.min(w, h) * 0.12;            // margin
  const bx = m, by = h * 0.34, bw = w - m * 2, bh = h - by - m;

  g.beginFill(palette.paper, 0.85);
  g.drawRect(bx, by, bw, bh);
  g.endFill();

  // Crenellated top — alternating merlons drawn as short up-strokes + caps.
  const merlons = 4;
  const mw = bw / (merlons * 2 - 1);
  for (let i = 0; i < merlons; i++) {
    const mx = bx + i * 2 * mw;
    const top = by - mw * 0.9;
    pen.rect(mx, top, mw, mw * 0.9, { color: ink, width: 2.2 });
    g.beginFill(palette.paper, 0.85);
    g.drawRect(mx + 1, top + 1, mw - 2, mw * 0.9);
    g.endFill();
  }

  // Wall outline.
  pen.rect(bx, by, bw, bh, { color: ink, width: 2.6 });

  // Gate — an arch (half-circle top) + jambs, in pencil for contrast.
  const gw = bw * 0.34, gh = bh * 0.55;
  const gx = bx + (bw - gw) / 2, gy = by + bh - gh;
  pen.line(gx, gy + gh, gx, gy + gh * 0.35, { color: palette.pencil, width: 2 });
  pen.line(gx + gw, gy + gh, gx + gw, gy + gh * 0.35, { color: palette.pencil, width: 2 });
  // Arch top as a wobbled half loop.
  const arc: { x: number; y: number }[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI + (Math.PI * i) / 8;   // π → 2π (top half)
    arc.push({ x: gx + gw / 2 + Math.cos(a) * (gw / 2), y: gy + gh * 0.35 + Math.sin(a) * (gw / 2) });
  }
  pen.stroke(arc, { color: palette.pencil, width: 2, double: false });

  // Pennant on a pole from the tallest merlon.
  const poleX = bx + bw * 0.5;
  const poleTop = by - mw * 0.9 - h * 0.14;
  pen.line(poleX, by - mw * 0.9, poleX, poleTop, { color: palette.pencil, width: 1.8 });
  pen.stroke(
    [{ x: poleX, y: poleTop }, { x: poleX + w * 0.16, y: poleTop + h * 0.04 }, { x: poleX, y: poleTop + h * 0.08 }],
    { color: ink, width: 2 },
  );

  const tex = bake(`castle:${Math.round(w)}x${Math.round(h)}:${side}`, g, w, h);
  if (tex) {
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    g.destroy();
    return s;
  }
  return g;
}
