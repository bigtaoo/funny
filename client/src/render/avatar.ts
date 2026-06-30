/**
 * avatar.ts — procedural player avatar (notebook doodle style).
 *
 * Two rendering modes:
 *   1. Icon avatar (avatarId 0-7): a pre-defined icon glyph on a coloured disc.
 *   2. Default: ink circle with the first letter of the player's name.
 *
 * Deterministic per (name, seed) so the same player always gets the same doodle.
 * Shared by the lobby profile chip, the settings screen, and the avatar picker.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { palette } from './theme';
import { buildIcon, IconKind } from './icons';

/** First visible glyph of a name, uppercased (handles CJK + latin). */
function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

/** 8 hand-crafted avatar tokens (icon + background colour), indices 0-7. */
const AVATAR_DEFS: Array<{ icon: IconKind; bg: number }> = [
  { icon: 'book',    bg: 0x4477cc },  // 0 scholar inkBlue (default-compatible)
  { icon: 'trophy',  bg: 0xcc9900 },  // 1 champion gold
  { icon: 'swords',  bg: 0xcc3333 },  // 2 warrior red
  { icon: 'castle',  bg: 0x4a9e4a },  // 3 sovereign green
  { icon: 'pencils', bg: 0x9955cc },  // 4 creator purple
  { icon: 'globe',   bg: 0x44aacc },  // 5 explorer cyan
  { icon: 'coin',    bg: 0xcc6633 },  // 6 merchant orange
  { icon: 'home',    bg: 0x667788 },  // 7 guardian grey-blue
];

/** Total number of avatar tokens available (for UI pickers). */
export const AVATAR_COUNT = AVATAR_DEFS.length;

/**
 * Build a square avatar container of side `size`, centred on (size/2, size/2).
 *
 * When `avatarId` is a valid index string ('0'-'7'), renders the corresponding
 * icon avatar; otherwise falls back to the letter-initial style.
 */
export function buildAvatar(size: number, name: string, seed = 7, avatarId?: string): PIXI.Container {
  const c = new PIXI.Container();
  const r = size / 2 - 2;
  const cx = size / 2, cy = size / 2;

  const idx = avatarId !== undefined ? parseInt(avatarId, 10) : -1;
  const def = (idx >= 0 && idx < AVATAR_DEFS.length) ? AVATAR_DEFS[idx] : null;

  const disc = new PIXI.Graphics();
  disc.beginFill(def ? def.bg : palette.inkBlue);
  disc.drawCircle(cx, cy, r);
  disc.endFill();
  new SketchPen(disc, seed).circle(cx, cy, r, {
    color: palette.pencil, width: 2.2, jitter: 1.2,
  });
  c.addChild(disc);

  if (def) {
    const iconS = Math.round(size * 0.62);
    const icon = buildIcon(def.icon, iconS, palette.paper);
    icon.x = Math.round(cx - iconS / 2);
    icon.y = Math.round(cy - iconS / 2);
    c.addChild(icon);
  } else {
    const letter = new PIXI.Text(initial(name), {
      fontSize: Math.round(size * 0.5),
      fill: palette.paper,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    letter.anchor.set(0.5, 0.5);
    letter.x = cx; letter.y = cy + 1;
    c.addChild(letter);
  }

  return c;
}
