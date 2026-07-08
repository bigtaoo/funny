// tileGraphics — pure PIXI drawing primitives for the world map. Extracted verbatim from
// WorldMapScene; each takes a target Graphics + params, holds no scene state.
import * as PIXI from 'pixi.js-legacy';
import { ISO_RATIO, diamondPath, diamondVertices } from '../../render/isoGrid';
import { getResLevelTexture, getResTexture, isResAtlasReady } from '../../render/resAtlasLoader';
import { getTerrainTexture, isTerrainAtlasReady } from '../../render/terrainAtlasLoader';
import { getBuildingTexture, isBuildingAtlasReady } from '../../render/buildingAtlasLoader';
import { isCityAtlasReady } from '../../render/cityAtlasLoader';
import { FOG_COLOR, ALLY_SECT_BORDER, TERRAIN_TEX_ALPHA, TERRAIN_TEX_ALPHA_DEFAULT, TERRAIN_TEX_TINT, TERRAIN_TEX_TINT_DEFAULT } from './tileStyle';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';
import type { WorldTileView } from '../../net/WorldApiClient';
import type { ProceduralTile } from '@nw/shared';

export function drawTileL1(
  g: PIXI.Graphics, tile: WorldTileView | null,
  fill: number, owner: number | null, fogged: boolean, tp: number, isAnchor: boolean,
  texName: TerrainTextureName, proc: ProceduralTile | null = null,
): void {
  const hh = (tp * ISO_RATIO) / 2;
  // Soft sketch grid, then the ground: hand-drawn texture fill once the atlas has
  // decoded, falling back to the flat desaturated color (see terrainFill) until then.
  g.lineStyle(0.7, 0xccbbaa, 0.18);
  const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
  if (tex) {
    const w = tp - 1;
    const h = w * ISO_RATIO;
    const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
    // Dark, busy obstacle weaves (mountain/river) are pushed down so they recede into the
    // paper instead of dominating the map edges; other terrain stays near-opaque.
    const texAlpha = TERRAIN_TEX_ALPHA[texName] ?? TERRAIN_TEX_ALPHA_DEFAULT;
    // Faint colored-pencil tint multiplied into the grey ground art (see TERRAIN_TEX_TINT).
    // Resource type is carried ENTIRELY by the motif sprite (drawResMotif) — the ground keeps
    // its plain terrain tint with no per-biome wash, so the map reads calm and ownership stays
    // the only strong color (tileStyle header). keep/stronghold keep their landmark terrain tint.
    const texTint = TERRAIN_TEX_TINT[texName] ?? TERRAIN_TEX_TINT_DEFAULT;
    g.beginTextureFill({ texture: tex, matrix: m, alpha: texAlpha, color: texTint });
  } else {
    g.beginFill(fill, 0.7);
  }
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();

  // Resource motif overlay: with resourceDensity=1.0 (ADR-032) every open tile is a resource tile,
  // so this paints a per-level heap on every one — dense by design, so the l1–l10 graded art
  // (taller/denser = higher level) reads on the map. Drawn BEFORE the fog return with fogged=false
  // always: resType is terrain, and §18.6 keeps the full resource art (incl. level detail) visible
  // even under fog (the "hide level outside vision" narrowing was abolished). The motif is an
  // addChild sprite, so it renders above the fog wash drawn on this Graphics' own polygon.
  // Must stay in lockstep with the map-editor's drawEditorTile (SLG map render parity).
  const motifResType = tile?.type === 'resource' ? tile.resType : (!tile && proc?.type === 'resource' ? proc.resType : undefined);
  if (motifResType) {
    drawResMotif(g, motifResType, tile?.level ?? proc?.level ?? 1, tp, false);
  }

  // Overlay landmark buildings for chokepoints / NPC strongholds. Like the ground texture,
  // these are TERRAIN features (their type is procedural, visible map-wide), so they draw
  // before the fog return, dimmed when fogged. Neutral ink — ownership is the wash below.
  const featType = tile?.type ?? proc?.type;
  if (featType === 'familyKeep' || featType === 'stronghold') {
    placeBuildingSprite(g, featType === 'familyKeep' ? 'building_keep' : 'building_stronghold', tp, hh, tp * 1.3, fogged);
  }

  // Ownership overlay (option-3): a light wash + colored border, not a full opaque fill —
  // territory reads clearly while the terrain/motif underneath stays legible. Motif sprites
  // are Graphics children and always render above this wash, so they are never covered.
  if (owner != null && !fogged) {
    const isBase = tile?.type === 'base';
    g.lineStyle(0);
    g.beginFill(owner, isBase ? 0.26 : 0.16);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    g.lineStyle(isBase ? 2.4 : 1.6, owner, 0.9);
    g.beginFill(0, 0);
    g.drawPolygon(diamondPath(tp - 1, { inset: 2.2 / tp }));
    g.endFill();
  }

  if (fogged) {
    g.lineStyle(0);
    g.beginFill(FOG_COLOR, 0.3);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    return;  // dynamic markers (city icon, level dot, sect border, watchtower) stay hidden under fog
  }

  // City icon on capital tiles: sprite layer handles this once the atlas is ready.
  if (isAnchor && !isCityAtlasReady()) {
    // Programmatic fallback icon, drawn once on the base's center anchor until the atlas decodes.
    drawCityIcon(g, tile!.mine ?? false, tile!.ally ?? false, tile!.level ?? 1, tp);
  }

  if (tile && tile.level > 1) {
    // Was the square's top-right corner (tp-6,6); nearest diamond analog is the
    // midpoint of the top→right edge, nudged slightly inward.
    const dotColor = tile.mine ? 0xcc2222 : (tile.ally ? 0x2e8b40 : (tile.occupied ? 0x2266cc : 0x888888));
    const v = diamondVertices(tp - 1);
    const dotX = (v.top[0] + v.right[0]) / 2 * 0.85;
    const dotY = (v.top[1] + v.right[1]) / 2 * 0.85;
    g.lineStyle(0);
    g.beginFill(dotColor, 0.9);
    g.drawCircle(dotX, dotY, 3);
    g.endFill();
  }

  // ADR-026 §1: building HP bar on attackable buildings under siege. Only drawn while damaged
  // (hp < maxHp) so full-HP buildings keep the map uncluttered; a depleted bar signals an active siege.
  if (tile && tile.maxHp && tile.hp != null && tile.hp < tile.maxHp) {
    drawHpBar(g, tile.hp, tile.maxHp, tp);
  }

  if (tile?.allySect) {
    g.lineStyle(2, ALLY_SECT_BORDER, 0.95);
    g.beginFill(0, 0);
    g.drawPolygon(diamondPath(tp - 1, { inset: Math.min(0.35, 5 / tp) }));
    g.endFill();
  }

  if (tile?.watchtower) {
    // Hand-drawn watchtower sprite once the atlas is ready; falls back to the geometric
    // tower until then. Anchored just inside the diamond's bottom vertex so it reads as
    // standing on the tile rather than poking past its edge.
    if (!placeBuildingSprite(g, 'icon_watchtower', tp, hh, tp * 0.95, false)) {
      const tcx = 0;
      const baseY = hh - 4;
      const towerW = Math.max(4, tp * 0.18);
      const towerH = Math.max(7, tp * 0.36);
      g.lineStyle(1, 0x4a3520, 0.9);
      g.beginFill(0xe8dcc0, 0.95);
      g.drawRect(tcx - towerW / 2, baseY - towerH, towerW, towerH);
      g.endFill();
      g.beginFill(0x4a3520, 0.95);
      g.drawPolygon([
        tcx - towerW / 2 - 1, baseY - towerH,
        tcx + towerW / 2 + 1, baseY - towerH,
        tcx, baseY - towerH - towerW,
      ]);
      g.endFill();
    }
  }
}

/**
 * Add a neutral-ink building sprite from building_atlas, anchored bottom-center just inside
 * the tile's lower vertex so the structure "stands" on the diamond and rises upward.
 * `targetH` is the on-screen pixel height. Returns false (drawing nothing) if the atlas
 * isn't ready or the frame is missing, so callers can fall back. Sprite children are cleaned
 * each redraw by drawTileSlot.
 */

export function placeBuildingSprite(
  g: PIXI.Graphics, name: string, tp: number, hh: number, targetH: number, fogged: boolean,
): boolean {
  if (!isBuildingAtlasReady()) return false;
  const tex = getBuildingTexture(name);
  if (!tex) return false;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 1);
  sp.scale.set(targetH / tex.height);
  sp.x = 0;
  sp.y = hh * 0.72;   // base sits near the lower part of the diamond, below center
  sp.alpha = fogged ? 0.5 : 1;
  g.addChild(sp);
  return true;
}

/**
 * ADR-026 §1: a small building-HP bar near the bottom of an attackable tile. Green→amber→red by ratio,
 * so an enemy base being ground down under a siege reads at a glance. Width scales with the tile size.
 */

export function drawHpBar(g: PIXI.Graphics, hp: number, maxHp: number, tp: number): void {
  // `g`'s local origin is the tile's diamond center (see drawTileL1); the bar sits just
  // above the diamond's bottom vertex instead of the old square's bottom edge.
  const hh = (tp * ISO_RATIO) / 2;
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const barW = tp * 0.7;
  const barH = Math.max(3, tp * 0.06);
  const x = -barW / 2;
  const y = hh - barH - 3;
  // Track
  g.lineStyle(0.6, 0x3a2a1a, 0.8);
  g.beginFill(0x2a1e12, 0.75);
  g.drawRect(x, y, barW, barH);
  g.endFill();
  // Fill: green (full) → amber (mid) → red (low)
  const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
  g.lineStyle(0);
  g.beginFill(fillColor, 0.95);
  g.drawRect(x, y, barW * ratio, barH);
  g.endFill();
}

/**
 * Programmatic city icon drawn on capital (base) tiles.
 * Tier 1 (lv 1-2): camp silhouette; Tier 2 (lv 3-5): walled town; Tier 3 (lv 6-8): castle;
 * Tier 4 (lv 9-10): grand citadel. Will be replaced by AI-generated sprites once assets land.
 */

export function drawCityIcon(g: PIXI.Graphics, mine: boolean, ally: boolean, lv: number, tp: number): void {
  const tier = lv <= 2 ? 1 : lv <= 5 ? 2 : lv <= 8 ? 3 : 4;
  const ink = mine ? 0xcc2222 : (ally ? 0x2e8b40 : 0x224488);
  const fill = mine ? 0xf5d5d5 : (ally ? 0xd5f0e0 : 0xd5e0f5);
  const margin = Math.max(4, tp * 0.08);
  const inner = tp - 1 - margin * 2;
  // `g`'s local origin is now the tile's diamond CENTER (see drawTileL1), not the old
  // square's top-left corner — `og` re-anchors this icon's inner square there. The icon
  // itself stays a plain square drawing (it's a placeholder pending real art anyway).
  const og = -tp / 2 + margin;

  g.lineStyle(1.2, ink, 0.9);

  if (tier === 1) {
    // Two tents
    g.beginFill(fill, 0.85);
    const tentW = inner * 0.42;
    const tentH = inner * 0.55;
    const y0 = og + inner * 0.35;
    [0.15, 0.52].forEach((fx) => {
      const tx = og + inner * fx;
      g.moveTo(tx, y0); g.lineTo(tx + tentW / 2, y0 - tentH); g.lineTo(tx + tentW, y0);
      g.closePath();
    });
    g.endFill();
    // ground line
    g.lineStyle(0.8, ink, 0.6);
    g.moveTo(og, og + inner * 0.35); g.lineTo(og + inner, og + inner * 0.35);
  } else if (tier === 2) {
    // Walled town: rectangle perimeter + small house inside
    const wy = og + inner * 0.15;
    const wh = inner * 0.72;
    g.beginFill(fill, 0.75);
    g.drawRect(og, wy, inner, wh);
    g.endFill();
    g.lineStyle(1.5, ink, 0.9);
    g.drawRect(og, wy, inner, wh);
    // Gate in center-bottom
    const gw = inner * 0.28;
    g.lineStyle(0);
    g.beginFill(ink, 0.4);
    g.drawRect(og + inner / 2 - gw / 2, wy + wh - wh * 0.36, gw, wh * 0.36);
    g.endFill();
    // Central tower
    g.lineStyle(1.2, ink, 0.9);
    g.beginFill(fill, 0.9);
    const tw = inner * 0.22, th = inner * 0.46;
    g.drawRect(og + inner / 2 - tw / 2, wy - th * 0.3, tw, th);
    g.endFill();
  } else if (tier === 3) {
    // Castle: outer wall with crenels + keep
    const wy = og + inner * 0.22;
    const wh = inner * 0.65;
    g.beginFill(fill, 0.80);
    g.drawRect(og, wy, inner, wh);
    g.endFill();
    g.lineStyle(1.5, ink, 0.9);
    g.drawRect(og, wy, inner, wh);
    // Crenellations top
    const cs = Math.max(2, inner * 0.07);
    g.lineStyle(0);
    g.beginFill(ink, 0.7);
    for (let i = 0; i < 4; i++) {
      g.drawRect(og + i * (inner / 4), wy - cs, inner / 8, cs);
    }
    g.endFill();
    // Keep tower
    const tw = inner * 0.3, th = inner * 0.7;
    g.lineStyle(1.5, ink, 0.9);
    g.beginFill(fill, 0.95);
    g.drawRect(og + inner / 2 - tw / 2, og - th * 0.1, tw, th);
    g.endFill();
  } else {
    // Grand citadel: thick walls + 2 side towers + tall keep
    const wy = og + inner * 0.28;
    const wh = inner * 0.60;
    g.beginFill(fill, 0.80);
    g.drawRect(og, wy, inner, wh);
    g.endFill();
    g.lineStyle(2, ink, 0.95);
    g.drawRect(og, wy, inner, wh);
    // Side towers
    const stW = inner * 0.22, stH = inner * 0.55;
    g.beginFill(fill, 0.92);
    g.drawRect(og - stW * 0.3, wy - stH * 0.15, stW, stH);
    g.drawRect(og + inner - stW * 0.7, wy - stH * 0.15, stW, stH);
    g.endFill();
    // Central keep (tallest)
    const kw = inner * 0.32, kh = inner * 0.85;
    g.beginFill(fill, 0.98);
    g.drawRect(og + inner / 2 - kw / 2, og - kh * 0.1, kw, kh);
    g.endFill();
    g.lineStyle(2, ink, 0.95);
    g.drawRect(og + inner / 2 - kw / 2, og - kh * 0.1, kw, kh);
    // Flag on top
    g.lineStyle(1, ink, 0.9);
    const flagX = og + inner / 2;
    const flagY = og - kh * 0.1;
    g.moveTo(flagX, flagY); g.lineTo(flagX, flagY - kh * 0.2);
    g.beginFill(ink, 0.85);
    g.moveTo(flagX, flagY - kh * 0.2);
    g.lineTo(flagX + inner * 0.12, flagY - kh * 0.14);
    g.lineTo(flagX, flagY - kh * 0.08);
    g.closePath();
    g.endFill();
  }
}

/**
 * Render a resource motif sprite onto a tile Graphics.
 *
 * When a hand-drawn `res_{resType}_l{level}` frame exists, draw that real per-level art:
 * the artwork alone carries level/abundance/defense — no programmatic count-replication or
 * pencil defense frames are layered on. All map resTypes now have per-level frames in the atlas
 * (paper/ink/graphite l1–l10 bespoke, metal l1–l10 baked heaps, sticker/铜矿 l6–l10 bespoke — sticker
 * only spawns at level ≥6, so it never needs l1–5). Any missing level falls back to the generic
 * `res_{resType}` sprite — deliberately one sprite, no abundance scatter, so the map stays calm.
 *
 * Falls back to a single programmatic shape if the atlas hasn't decoded yet.
 */

export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number, fogged = false): void {
  const lv = Math.max(1, Math.min(10, level));
  // `g`'s local origin is the tile's diamond center (see drawTileL1); the motif sits
  // centred and slightly low, y-offset flattened (×0.6) so it never pokes past the
  // shallower diamond edges near the tile's left/right tips.
  const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];

  // Outside vision: reveal the resource TYPE only — a single dimmed motif (no level detail,
  // which §18 keeps hidden under fog, same as the level dot).
  if (fogged) {
    if (!isResAtlasReady()) { drawResMotifFallback(g, resType, tp); return; }
    const ftex = getResTexture(resType);
    if (!ftex) return;
    const sp = new PIXI.Sprite(ftex);
    sp.anchor.set(0.5, 0.5);
    // Generic type frame (tall, w<h) — keep max(w,h) so it stays bounded; 0.40 matches the
    // revealed per-level motif size below so the sprite doesn't jump size when fog clears.
    sp.scale.set((tp * 0.40) / Math.max(ftex.width, ftex.height));
    sp.alpha = 0.35;
    [sp.x, sp.y] = toLocal(0.5, 0.52);
    g.addChild(sp);
    return;
  }

  // Programmatic fallback while the atlas is still decoding.
  if (!isResAtlasReady()) {
    drawResMotifFallback(g, resType, tp);
    return;
  }

  // Real per-level art when it exists; otherwise a single generic placeholder sprite.
  const levelTex = getResLevelTexture(resType, lv);
  const tex = levelTex ?? getResTexture(resType);
  if (!tex) return;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  // Per-level frames all share the same 128px WIDTH and encode the level in HEIGHT (higher
  // level = taller/denser), so scale them by width — this keeps the per-level height
  // difference instead of normalizing it away via max(w,h). The generic fallback frame
  // (types without per-level art) is TALLER than wide, so it stays on max(w,h) to stay
  // bounded. 0.40: shrunk from 0.55→0.48→0.40 to leave clear gaps between adjacent tiles'
  // motifs (resourceDensity=1.0 puts one on every tile), while l1..l10 still read apart.
  const denom = levelTex ? tex.width : Math.max(tex.width, tex.height);
  sp.scale.set((tp * 0.40) / denom);
  [sp.x, sp.y] = toLocal(0.5, 0.52);
  g.addChild(sp);
}

/** Single programmatic fallback icon when res_atlas is not yet loaded. Draws one small stationery-themed shape. */

export function drawResMotifFallback(g: PIXI.Graphics, resType: string, tp: number): void {
  const alpha = 0.6;
  const r = tp * 0.12;
  // Center-relative, y flattened to match drawResMotif's diamond-safe placement (`g`'s
  // local origin is the tile's diamond center, not the old square's top-left corner).
  {
    const cx = 0, cy = 0.02 * tp * 0.6;
    g.lineStyle(0);
    if (resType === 'ink') {
      // Ink drop: teardrop shape
      g.beginFill(0x3355aa, alpha);
      g.drawEllipse(cx, cy + r * 0.2, r * 0.65, r * 0.85);
      g.endFill();
      g.beginFill(0x3355aa, alpha);
      g.moveTo(cx, cy - r * 0.9);
      g.lineTo(cx - r * 0.45, cy - r * 0.05);
      g.lineTo(cx + r * 0.45, cy - r * 0.05);
      g.closePath();
      g.endFill();
    } else if (resType === 'paper') {
      // Paper: small rectangle with folded corner
      g.lineStyle(0.8, 0x4477bb, alpha);
      g.beginFill(0xf0ecdd, alpha * 0.9);
      g.drawRect(cx - r * 0.7, cy - r * 0.85, r * 1.4, r * 1.7);
      g.endFill();
      g.lineStyle(0.6, 0x4477bb, alpha * 0.7);
      g.moveTo(cx - r * 0.3, cy - r * 0.85);
      g.lineTo(cx - r * 0.3, cy - r * 0.35);
      g.moveTo(cx - r * 0.3, cy - r * 0.15);
      g.lineTo(cx - r * 0.3, cy + r * 0.55);
      g.lineStyle(0);
    } else if (resType === 'graphite') {
      // Graphite/pencil: elongated hexagon
      g.beginFill(0x778899, alpha);
      g.moveTo(cx, cy - r);
      g.lineTo(cx + r * 0.5, cy - r * 0.5);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.lineTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx - r * 0.5, cy - r * 0.5);
      g.closePath();
      g.endFill();
      g.beginFill(0xccaa44, alpha);
      g.moveTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.closePath();
      g.endFill();
    } else if (resType === 'metal') {
      // Metal: bolt head (circle) + shaft
      g.beginFill(0x889966, alpha);
      g.drawCircle(cx, cy - r * 0.3, r * 0.6);
      g.endFill();
      g.beginFill(0x778855, alpha);
      g.drawRect(cx - r * 0.22, cy + r * 0.2, r * 0.44, r * 0.8);
      g.endFill();
    } else {
      // sticker / default: 5-point star
      g.beginFill(0xcc9922, alpha);
      const pts = 5;
      const outer = r * 0.9, inner = r * 0.4;
      const startAngle = -Math.PI / 2;
      for (let i = 0; i < pts * 2; i++) {
        const angle = startAngle + (i * Math.PI) / pts;
        const rad = i % 2 === 0 ? outer : inner;
        if (i === 0) g.moveTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
        else g.lineTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
      }
      g.closePath();
      g.endFill();
    }
  }
}

/** L2 medium tile: calm terrain fill + ownership wash/border (no motifs at this zoom) + fog. */

export function drawTileL2(g: PIXI.Graphics, fill: number, owner: number | null, fogged: boolean, tp: number): void {
  g.lineStyle(0);
  g.beginFill(fill, 0.85);
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();
  if (owner != null && !fogged) {
    // No motif carries the signal at medium zoom, so ownership uses a stronger wash + border
    // to keep the territory map readable while terrain stays visible underneath.
    g.beginFill(owner, 0.42);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    g.lineStyle(1.4, owner, 0.85);
    g.beginFill(0, 0);
    g.drawPolygon(diamondPath(tp - 1, { inset: 1.6 / tp }));
    g.endFill();
  }
  if (fogged) {
    g.lineStyle(0);
    g.beginFill(FOG_COLOR, 0.3);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
  }
}

// ── L3 overview (batched Graphics) ─────────────────────────────────────────
// Renders on a dirty flag in update(), so mousemove spam doesn't trigger it.
// Tiles grouped by color → one beginFill + N drawRect per color group (fast).

export function drawStar(g: PIXI.Graphics, cx: number, cy: number, r: number, color: number, filled: boolean): void {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    // Deterministic per-vertex radius jitter (index-seeded, position-independent) so the
    // star reads as hand-drawn ink like the rest of the map, yet stays stable across the
    // ~5s overlay redraws and while panning — no shimmer.
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const wob = ((h - Math.floor(h)) - 0.5) * r * 0.14;
    pts.push(cx + Math.cos(a) * (rad + wob), cy + Math.sin(a) * (rad + wob));
  }
  g.lineStyle(1.5, 0x6a5a20, 0.9);
  if (filled) g.beginFill(color, 0.95);
  g.drawPolygon(pts);
  if (filled) g.endFill();
}
