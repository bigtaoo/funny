/**
 * avatar.ts — procedural player avatar (notebook doodle style).
 *
 * No avatar-image pipeline exists yet, so a player's face is drawn: a hand-drawn
 * ink circle (faction blue) with the first letter of their name scrawled inside.
 * Deterministic per (name, seed) so the same player always gets the same doodle.
 * Shared by the lobby profile chip and the settings screen.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { palette } from './theme';

/** First visible glyph of a name, uppercased (handles CJK + latin). */
function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

/**
 * Build a square avatar container of side `size`, centred on (size/2, size/2):
 * a filled hand-drawn circle with the name's initial. `seed` keeps the scrawl
 * stable across redraws.
 */
export function buildAvatar(size: number, name: string, seed = 7): PIXI.Container {
  const c = new PIXI.Container();
  const r = size / 2 - 2;
  const cx = size / 2, cy = size / 2;

  const disc = new PIXI.Graphics();
  disc.beginFill(palette.inkBlue);
  disc.drawCircle(cx, cy, r);
  disc.endFill();
  new SketchPen(disc, seed).circle(cx, cy, r, {
    color: palette.pencil, width: 2.2, jitter: 1.2,
  });
  c.addChild(disc);

  const letter = new PIXI.Text(initial(name), {
    fontSize: Math.round(size * 0.5),
    fill: palette.paper,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  });
  letter.anchor.set(0.5, 0.5);
  letter.x = cx; letter.y = cy + 1;
  c.addChild(letter);

  return c;
}
