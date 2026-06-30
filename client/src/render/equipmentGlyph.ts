/**
 * equipmentGlyph.ts — procedural stationery icons for equipment (EQUIPMENT_DESIGN §20.3).
 *
 * The design's "near-zero art cost" promise (§2 / art-direction §9.2): equipment
 * is NOT hand-drawn per item — each of the 12 defIds is composed from a per-slot
 * base shape (weapon = pen, armor = book cover, trinket = accessory) tinted by its
 * rarity media (pencil → pen → marker → highlighter/foil/seal). One SketchPen pass
 * keeps the hand-drawn notebook look shared with the board/UI.
 *
 * Pure draw module — no layout, no baking. Callers pass a fresh Graphics, a slot,
 * a rarity, a box size and a seed (deterministic scrawl). Centered at (0,0).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { palette } from './theme';
import type { EquipSlot, EquipRarity } from '../game/meta/SaveData';

/** Per-rarity media palette: line ink, body fill, accent (shine / foil). */
interface MediaStyle {
  /** Outline / seam ink. */
  ink: number;
  /** Body fill (the stationery's own color). */
  fill: number;
  /** Accent for rare/epic flourishes (marker sheen / gold foil). */
  accent: number;
}

/**
 * Rarity → media style. Mirrors §2: common=pencil(grey) / fine=fountain pen(blue) /
 * rare=marker(orange) / epic=highlighter+gold foil(purple+gold). Body colors line up
 * with EquipmentScene.RARITY_COLOR so the glyph and its border read as one item.
 */
const MEDIA: Record<EquipRarity, MediaStyle> = {
  common: { ink: palette.pencil,  fill: 0x9aa0a6, accent: palette.pencilLight },
  fine:   { ink: palette.inkBlue, fill: 0x4477cc, accent: 0x6f9fe0 },
  rare:   { ink: 0xb5651d,        fill: 0xe08a2c, accent: 0xf6b65a },
  epic:   { ink: 0x6f3f93,        fill: 0xaa55cc, accent: 0xd9b44a }, // purple body + gold foil accent
};

/**
 * Draw an equipment glyph into `g`, centered at the Graphics origin and fitting a
 * `size`×`size` box. Does NOT clear `g` — the caller owns composition.
 *
 * @param slot   weapon / armor / trinket — selects the base shape.
 * @param rarity selects the media palette (MEDIA).
 * @param size   bounding box edge in design px (glyph drawn at ~80% to leave margin).
 * @param seed   deterministic pen seed (same seed → same scrawl across re-draws).
 */
export function drawEquipmentGlyph(
  g: PIXI.Graphics,
  slot: EquipSlot,
  rarity: EquipRarity,
  size: number,
  seed = 1,
): void {
  const pen = new SketchPen(g, seed);
  const m = MEDIA[rarity];
  const r = (size / 2) * 0.8;        // half-extent the shape draws within
  const lw = Math.max(1.4, size * 0.05); // outline width scaled to icon size

  switch (slot) {
    case 'weapon':   drawPen(pen, g, m, r, lw, rarity); break;
    case 'armor':    drawCover(pen, g, m, r, lw, rarity); break;
    case 'trinket':  drawTrinket(pen, g, m, r, lw, rarity); break;
  }
}

// ── weapon = a pen/pencil/marker drawn on the diagonal ─────────────────────────

function drawPen(
  pen: SketchPen, g: PIXI.Graphics, m: MediaStyle, r: number, lw: number, rarity: EquipRarity,
): void {
  // Barrel runs bottom-left → top-right; tip pokes past the top-right end.
  const A = { x: -r * 0.7, y: r * 0.75 };   // butt end
  const B = { x: r * 0.45, y: -r * 0.45 };  // shoulder (barrel meets tip)
  const tip = { x: r * 0.75, y: -r * 0.78 }; // nib point
  // Epic = highlighter: a fatter chisel barrel; others taper like a pen.
  const barrelW = rarity === 'epic' ? r * 0.5 : r * 0.36;

  // Body fill (thick soft stroke), then an ink seam down the middle for definition.
  pen.stroke([A, B], { color: m.fill, width: barrelW, taper: 0.92, double: false });
  pen.stroke([A, B], { color: m.ink, width: lw, taper: 0.85, alpha: 0.65 });

  // Nib: a short dark wedge from the shoulder to the point.
  pen.stroke([B, tip], { color: m.ink, width: lw * 1.6, taper: 0.15, double: false });

  // Butt cap — a small cross stroke so the barrel reads as a closed end.
  pen.line(A.x - r * 0.12, A.y - r * 0.12, A.x + r * 0.12, A.y + r * 0.12, { color: m.ink, width: lw, double: false });

  // Rare/epic sheen: a bright accent highlight along the barrel.
  if (rarity === 'rare' || rarity === 'epic') {
    pen.stroke(
      [{ x: A.x + r * 0.1, y: A.y - r * 0.16 }, { x: B.x - r * 0.05, y: B.y - r * 0.2 }],
      { color: m.accent, width: lw * 0.9, taper: 0.7, alpha: 0.8, double: false },
    );
  }
}

// ── armor = a book cover / binding (shield analogue) ───────────────────────────

function drawCover(
  pen: SketchPen, g: PIXI.Graphics, m: MediaStyle, r: number, lw: number, rarity: EquipRarity,
): void {
  const w = r * 1.3, h = r * 1.7;
  const x = -w / 2, y = -h / 2;

  // Filled cover panel (flat fill — never gradient, art-direction §4) + scribbled frame.
  g.beginFill(m.fill, rarity === 'common' ? 0.5 : 0.7).drawRoundedRect(x, y, w, h, r * 0.18).endFill();
  pen.rect(x, y, w, h, { color: m.ink, width: lw, double: false });

  // Spine — a doubled vertical line a bit in from the left edge.
  const spineX = x + w * 0.26;
  pen.line(spineX, y + h * 0.08, spineX, y + h * 0.92, { color: m.ink, width: lw * 0.9 });

  // Cross-hatch texture on the cover face (leather/foil grain) for mid+ rarities.
  if (rarity !== 'common') {
    pen.hatch(spineX + 2, y + h * 0.12, w * 0.62, h * 0.76, { color: m.accent, spacing: 6, alpha: 0.4 });
  }
  // Epic foil: a gold corner tick.
  if (rarity === 'epic') {
    pen.line(x + w * 0.74, y + h * 0.1, x + w * 0.92, y + h * 0.1, { color: m.accent, width: lw * 1.2, double: false });
    pen.line(x + w * 0.92, y + h * 0.1, x + w * 0.92, y + h * 0.28, { color: m.accent, width: lw * 1.2, double: false });
  }
}

// ── trinket = a small accessory (clip / bookmark / sticker / seal) ─────────────

function drawTrinket(
  pen: SketchPen, g: PIXI.Graphics, m: MediaStyle, r: number, lw: number, rarity: EquipRarity,
): void {
  // Base = a hanging tag/bookmark: rounded body with a punched hole + string.
  const w = r * 1.0, h = r * 1.5;
  const x = -w / 2, y = -h * 0.42;

  g.beginFill(m.fill, rarity === 'common' ? 0.5 : 0.72).drawRoundedRect(x, y, w, h, r * 0.22).endFill();
  pen.rect(x, y, w, h, { color: m.ink, width: lw, double: false });

  // Punched hole near the top + a short hanging string above it.
  const holeY = y + h * 0.16;
  pen.circle(0, holeY, r * 0.16, { color: m.ink, width: lw * 0.8, double: false });
  pen.line(0, holeY - r * 0.16, 0, y - r * 0.32, { color: m.accent, width: lw, double: false });

  // Notch at the bottom (classic bookmark pennant) for rare+.
  if (rarity !== 'common') {
    const by = y + h;
    pen.stroke(
      [{ x: x + w * 0.5, y: by }, { x: 0, y: by - r * 0.3 }, { x: x + w * 0.5 + w * 0.5, y: by }],
      { color: m.ink, width: lw * 0.9, double: false },
    );
  }
  // Epic seal: a wax dot in the center.
  if (rarity === 'epic') {
    g.beginFill(m.accent, 0.85).drawCircle(0, y + h * 0.56, r * 0.22).endFill();
    pen.circle(0, y + h * 0.56, r * 0.22, { color: m.ink, width: lw * 0.7, double: false });
  }
}
