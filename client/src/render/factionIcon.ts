/**
 * factionIcon.ts — single source of truth for a card's FACTION mark.
 *
 * The two factions (`tao` / `anna`) are named after the story leads, so showing
 * the faction *name* next to a character's own name reads as a second name and
 * confuses players (AUCTION/ROSTER feedback 2026-07-17). Instead every faction
 * site shows a small totem: an emblem that reads by silhouette first and by the
 * faction colour second.
 *
 *   tao  — an upward fountain-pen nib (writing / blue ink); sharp, vertical.
 *   anna — a hand-scribbled star; round, radial — opposite silhouette.
 *
 * Colour lives here too (`FACTION_COLOR`) so the four call sites (card detail /
 * list / skins / feed) stop hard-coding `0xcc4466` / `0x4477cc` and can never
 * drift — same lesson as the equipment-icon unified source.
 *
 * Art path mirrors buildEquipIcon: when the AI totem atlas lands, fill in
 * `getFactionIconTexture` and callers keep working unchanged. Until then the
 * procedural glyph below is the placeholder — swap it, don't re-plumb callers.
 */
import * as PIXI from 'pixi.js-legacy';
import { getCachedDisplay } from '../ui/widgets/uiCache';
import { SketchPen } from './sketch';
import type { Faction } from '../game/meta/cardDefs';

/** Faction accent colour — the ONE place tao/anna colours are defined. */
export const FACTION_COLOR: Record<Faction, number> = {
  tao:  0x4477cc, // blue ink
  anna: 0xcc4466, // red ink
};

// ── Placeholder glyphs (swap for the totem atlas when art arrives) ──────────

/** tao — a fountain-pen nib pointing up: tapered body, centre slit, ink drop. */
function drawNib(g: PIXI.Graphics, s: number, color: number): void {
  const cx = s / 2;
  const topY = s * 0.14, botY = s * 0.74, halfW = s * 0.26;
  // Nib body: a tall triangle tapering to the tip at the bottom.
  g.beginFill(color, 1);
  g.lineStyle(0);
  g.drawPolygon([cx, botY, cx - halfW, topY, cx + halfW, topY]);
  g.endFill();
  const pen = new SketchPen(g, 0x1b7f);
  // Centre slit — thin channel from the shoulder down toward the tip.
  pen.stroke([{ x: cx, y: topY + s * 0.06 }, { x: cx, y: botY - s * 0.02 }],
    { color: 0xfaf9f5, width: Math.max(1, s * 0.05), jitter: 0.2, taper: 0.9, double: false });
  // Ink drop below the tip.
  g.beginFill(color, 1);
  g.drawCircle(cx, s * 0.9, s * 0.09);
  g.endFill();
}

/** anna — a hand-scribbled five-pointed star with a small hollow centre. */
function drawStarTotem(g: PIXI.Graphics, s: number, color: number): void {
  const cx = s / 2, cy = s * 0.5, rO = s * 0.42, rI = s * 0.17;
  const flat: number[] = [];
  const loop: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? rO : rI;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    flat.push(x, y);
    loop.push({ x, y });
  }
  g.beginFill(color, 1);
  g.lineStyle(0);
  g.drawPolygon(flat);
  g.endFill();
  loop.push(loop[0]!);
  const pen = new SketchPen(g, 0x57a3);
  pen.stroke(loop, { color, width: Math.max(1, s * 0.04), jitter: 0.3, taper: 0.95, double: false });
  // Hollow centre so it reads as a totem crest, not a rating star.
  g.beginFill(0xfaf9f5, 1);
  g.drawCircle(cx, cy, s * 0.07);
  g.endFill();
}

const DRAW_FACTION: Record<Faction, (g: PIXI.Graphics, s: number, color: number) => void> = {
  tao:  drawNib,
  anna: drawStarTotem,
};

/**
 * Texture for a faction totem from the AI atlas, or null until it is loaded.
 * Stub for now (no atlas yet) — callers fall back to the procedural glyph.
 */
export function getFactionIconTexture(_faction: Faction): PIXI.Texture | null {
  return null;
}

/**
 * The faction totem, sized `size × size`, tinted in the faction colour. Returns
 * a baked Sprite (or a live Graphics in headless tests), centred in its box —
 * position by the top-left corner, same contract as buildIcon. Every faction
 * mark MUST come from here so the totem + colour read identically everywhere.
 */
export function buildFactionIcon(faction: Faction, size: number): PIXI.DisplayObject {
  const tex = getFactionIconTexture(faction);
  if (tex) {
    const sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0, 0);
    sprite.width = sprite.height = size;
    sprite.tint = FACTION_COLOR[faction];
    return sprite;
  }
  const s = Math.round(size);
  const color = FACTION_COLOR[faction];
  const key = `faction:${faction}:${s}`;
  return getCachedDisplay(key, () => {
    const g = new PIXI.Graphics();
    DRAW_FACTION[faction](g, s, color);
    return g;
  }, s, s);
}
