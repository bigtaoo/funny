// tileGraphics/tiles — tile-level drawing (L1/L2 tiles, building sprite placement, and the
// programmatic city icon fallback). Extracted verbatim from WorldMapScene; each takes a target
// Graphics + params, holds no scene state.
import * as PIXI from 'pixi.js-legacy';
import { ISO_RATIO, diamondPath, diamondVertices } from '../../../render/isoGrid';
import { getTerrainTexture, isTerrainAtlasReady } from '../../../render/atlas/terrainAtlasLoader';
import { getBuildingTexture, isBuildingAtlasReady } from '../../../render/atlas/buildingAtlasLoader';
import { isCityAtlasReady } from '../../../render/atlas/cityAtlasLoader';
import { FOG_COLOR, ALLY_SECT_BORDER, SECT_BASE_TINT, ALLY_SECT_BASE_TINT, TERRAIN_TEX_ALPHA, TERRAIN_TEX_ALPHA_DEFAULT, TERRAIN_TEX_TINT, TERRAIN_TEX_TINT_DEFAULT, biomeGroundTint, obstacleTextureName } from '../tileStyle';
import type { TerrainTextureName } from '../../../render/atlas/terrainAtlasLoader';
import type { WorldTileView } from '../../../net/WorldApiClient';
import { worldSeed, obstacleShoreAt, type ProceduralTile } from '@nw/shared';
import { drawResMotif } from './resources';
import { drawHpBar } from './primitives';

// Player-built structure sprite heights, as a fraction of the tile pitch `tp` (2026-08-15,
// "瞭望塔和拒马的表现太奇怪了，看起来乱糟糟的").
//
// Sizing rule for anything a player can build on MANY ADJACENT tiles: the sprite's on-screen
// WIDTH (targetH × the packed frame's aspect) must stay near the x-distance between two
// neighbouring tiles' anchors, which under the 2:1 iso projection is only tp/2 — not the
// diamond's full tp width. Landmark terrain (building_stronghold/_bridge/_plankway at tp*1.3) may exceed
// that because it's one-per-region; a watchtower/blocker band cannot.
//   watchtower 256×198 (1.29:1) → 0.40 × 1.29 ≈ 0.52 tp wide
//   blocker    256×88  (2.91:1) → 0.22 × 2.91 ≈ 0.64 tp wide
// The old values (0.95 / 0.50 → 1.23 tp / 1.45 tp wide, i.e. 2.5–2.9× the neighbour spacing)
// made every tower/barricade cover ~3 tiles' worth of its neighbours, so a defensive line
// smeared into one unreadable hatch blob instead of N countable buildings.
const WATCHTOWER_H = 0.40;
const BLOCKER_H = 0.22;
// icon_arrowTower 129×256 (1:1.98) — added 2026-08-17, see design/product/slg-building-art.md.
// Deliberately narrower than watchtower/blocker: arrowTower's own geometric fallback (below) was
// already a slim ~0.16 tp-wide spike and nobody complained, so the new sprite targets a similarly
// narrow screen width instead of reusing the wider watchtower/blocker budget — 0.50 × 1.98 ≈
// 0.25 tp wide, well clear of the tp/2 neighbour-spacing ceiling. First-pass estimate, not yet
// checked against a real screenshot (same caveat the other two constants had before the 2026-08-15
// correction) — revisit if a player-built row of arrow towers reads oddly.
const ARROWTOWER_H = 0.50;
// Where a structure sprite's BASE sits, as a fraction of the diamond's half-height `hh` below the
// tile center (see placeBuildingSprite). 0.72 is the default for anything TALL (watchtower, arrow
// tower): the sprite rises from near the lower vertex, so its mass ends up above the tile center
// and it reads as standing on the ground.
//
// The blocker is the exception (2026-08-17, "拒马稍微往上放点，使其看起来在格子中间"). It's a WIDE,
// FLAT prop — sprite height is only tp*0.22 against hh = tp*0.5/2 = tp*0.25 — so with the default
// base its whole silhouette lived in the diamond's lower half and looked like it had slid off the
// cell toward the front vertex. Centering rule for a flat prop: put the base at spriteH/2 below the
// center, i.e. f = (tp*BLOCKER_H/2) / hh = BLOCKER_H / ISO_RATIO = 0.44 — that lands the sprite's
// visual center exactly on the tile center. 0.50 keeps a sliver of the "sits slightly forward"
// grounding cue while still reading as centered in the cell.
const BLOCKER_BASE_F = 0.50;

export function drawTileL1(
  g: PIXI.Graphics, tile: WorldTileView | null,
  fill: number, owner: number | null, fogged: boolean, tp: number, isAnchor: boolean,
  texName: TerrainTextureName, proc: ProceduralTile | null = null,
  tx = 0, ty = 0, worldId = '', ownerBorder = true,
): void {
  const hh = (tp * ISO_RATIO) / 2;
  // Resource type of this tile (from live tile state, else the uncached procedural value) — drives
  // the motif sprite. May be the level-gated copper-mine override ('sticker'), which is a scattered
  // per-tile special, NOT a spatial zone — so it must NOT drive the ground wash (see groundResType).
  // 2026-08-09 bug fix: this used to require `tile.type === 'resource'`, so the icon vanished the
  // moment ANY tile was captured (occupied territory writes `type: 'territory'` but keeps `resType`
  // on the doc — see worldsvc settleOccupation/landSiege — and the server always sends `resType`
  // whenever present, regardless of `type`, see core/map.ts tileDocView). A live tile's resType is now
  // trusted unconditionally; only the uncached PROCEDURAL fallback (no live tile yet) still gates on
  // proc.type==='resource', since a procedural guess for a captured tile's real type isn't available.
  const motifResType = tile ? tile.resType : (proc?.type === 'resource' ? proc.resType : undefined);
  // Ground wash uses the tile's PROVINCE leaning type (ignores the copper override, which is a
  // scattered per-tile special, not a province-level trait) so a whole province reads as one
  // continuous region even where copper/sticker tiles poke through as icons, and even though the
  // ACTUAL per-tile resType is independently mixed within that province (2026-07-15 rewrite) —
  // decouples "which resource does this province lean toward" from "what's the copper roll for this
  // one tile" (see biomeGroundTint/biomeMixAt/leaningResourceForProvince in @nw/shared). Must stay in
  // lockstep with the map-editor's drawEditorTile (SLG map render parity).
  const groundTint = motifResType ? biomeGroundTint(tx, ty, worldSeed(worldId)) : undefined;
  // Soft sketch grid, then the ground: hand-drawn texture fill once the atlas has
  // decoded, falling back to the flat desaturated color (see terrainFill) until then.
  g.lineStyle(0.7, 0xccbbaa, 0.08); // 0.18→0.08 (2026-07-11): at map-wide scale the per-tile grid was the strongest repeating signal on screen, competing with the biome/motif legibility pass
  const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
  if (tex) {
    const w = tp - 1;
    const h = w * ISO_RATIO;
    const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
    // Dark, busy obstacle weaves (mountain/river) are pushed down so they recede into the
    // paper instead of dominating the map edges; other terrain stays near-opaque.
    const texAlpha = TERRAIN_TEX_ALPHA[texName] ?? TERRAIN_TEX_ALPHA_DEFAULT;
    // Faint colored-pencil tint multiplied into the grey ground art (see TERRAIN_TEX_TINT).
    // Resource tiles wash the ground toward their biome hue (RES_TEX_TINT) so same-biome zones read
    // as continuous colored regions at a glance (三战-style terrain legibility); the tints are faint
    // & paper-adjacent, so the map stays calm and ownership remains the only strong color.
    // Non-resource terrain (land/obstacle/keep/…) keeps its per-texture tint. Must stay in
    // lockstep with the map-editor's drawEditorTile (SLG map render parity).
    const texTint = groundTint ?? TERRAIN_TEX_TINT[texName] ?? TERRAIN_TEX_TINT_DEFAULT;
    g.beginTextureFill({ texture: tex, matrix: m, alpha: texAlpha, color: texTint });
  } else {
    g.beginFill(fill, 0.7);
  }
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();

  // Obstacle-edge "shore" wash (2026-07-12): river/mountain bands rasterize as a hard per-tile
  // boolean, so the hand-drawn obstacle art meeting grass read as an abrupt cut even though the
  // band's boundary line itself wobbles organically. A tile bordering an obstacle gets a faded
  // second pass of that obstacle's texture (obstacleShoreAt), softening the cut into a ~1-tile
  // "bank" fringe instead of reworking the band shapes for sub-tile resolution. Skipped on the
  // obstacle tile itself (drawn at full strength above) and on bridge/plankway (crossing art
  // already reads as the spanned terrain). Must stay in lockstep with the map-editor's
  // drawEditorTile (SLG map render parity).
  const featTypeForShore = tile?.type ?? proc?.type;
  if (tex && featTypeForShore !== 'obstacle' && featTypeForShore !== 'bridge' && featTypeForShore !== 'plankway') {
    const shore = obstacleShoreAt(worldId, tx, ty);
    if (shore) {
      const shoreTexName = obstacleTextureName(shore.kind);
      const shoreTex = isTerrainAtlasReady() ? getTerrainTexture(shoreTexName) : null;
      if (shoreTex) {
        const w = tp - 1;
        const h = w * ISO_RATIO;
        const m = new PIXI.Matrix(w / shoreTex.width, 0, 0, h / shoreTex.height, -w / 2, -h / 2);
        g.beginTextureFill({ texture: shoreTex, matrix: m, alpha: shore.alpha, color: TERRAIN_TEX_TINT[shoreTexName] ?? TERRAIN_TEX_TINT_DEFAULT });
        g.drawPolygon(diamondPath(tp - 1));
        g.endFill();
      }
    }
  }

  // Resource motif overlay: with resourceDensity=1.0 (ADR-032) every open tile is a resource tile,
  // so this paints a per-level heap on every one — dense by design, so the l1–l10 graded art
  // (taller/denser = higher level) reads on the map. Drawn BEFORE the fog return with fogged=false
  // always: resType is terrain, and §18.6 keeps the full resource art (incl. level detail) visible
  // even under fog (the "hide level outside vision" narrowing was abolished). The motif is an
  // addChild sprite, so it renders above the fog wash drawn on this Graphics' own polygon.
  // Skipped when the tile already carries a building — a captured resource tile keeps its resType
  // forever (see the motifResType comment above), but once a landmark/watchtower/player structure
  // stands on it the heap art has nothing left to say and only clutters the read (2026-08-17,
  // 用户截图：箭塔/拒马格子上还叠着资源图标，看着乱). Must stay in lockstep with the map-editor's
  // drawEditorTile (SLG map render parity) — the editor never has the watchtower/structure half of
  // this (it knows nothing of live player state), but the terrain half must match exactly.
  const featType = tile?.type ?? proc?.type;
  // CITY GROUND (`familyKeep` = capital/graded city, `center` = world center): no per-tile art at all.
  // The city's own art is ONE sprite on the city layer (WorldMapRenderer/city.ts), sized to the whole
  // 3/5/7/9-tile footprint and masked to its plot — so a footprint tile that also stamped something of
  // its own would be stamping underneath that sprite. `familyKeep` used to stamp `building_keep` here:
  // harmless-looking on a procedural city (proceduralTile marks only the single anchor tile, so the one
  // gatehouse sat hidden under the sprite) but ruinous on a PUBLISHED one, where rasterizeMapEdits paints
  // the full N×N footprint as familyKeep and every cell stamped its own gatehouse at 1.3× tile size —
  // the same wall of overlapping masonry the deleted scattered-familyKeep tile class produced
  // (2026-08-19, see server/shared/src/slg/mapgen/tileGen.ts). Dropped 2026-08-19: `center` never had
  // the stamp, and city ground now behaves uniformly. The resource-motif suppression stays — city ground
  // keeps its biome `resType` (mapEdit.ts/tileGen.ts), and a resource heap has nothing to say under a
  // castle either.
  const isCityGround = featType === 'familyKeep' || featType === 'center';
  const featBuilding = featType === 'stronghold' ? 'building_stronghold'
    : featType === 'bridge' ? 'building_bridge'
    : featType === 'plankway' ? 'building_plankway'
    : null;
  const hasBuilding = !!featBuilding || isCityGround || !!tile?.watchtower || !!tile?.structure;
  if (motifResType && !hasBuilding) {
    drawResMotif(g, motifResType, tile?.level ?? proc?.level ?? 1, tp, false, tx, ty);
  }

  // Overlay landmark buildings for NPC strongholds / crossings. Like the ground texture, these are
  // TERRAIN features (their type is procedural, visible map-wide), so they draw before the fog return,
  // dimmed when fogged. Neutral ink — ownership is the wash below.
  if (featBuilding) {
    placeBuildingSprite(g, featBuilding, tp, hh, tp * 1.3, fogged);
  }

  // Ownership overlay (option-3): a light wash + colored border, not a full opaque fill —
  // territory reads clearly while the terrain/motif underneath stays legible. Motif sprites
  // are Graphics children and always render above this wash, so they are never covered.
  // The border only draws where `ownerBorder` says this tile actually touches a boundary
  // (see pool.ts::ownerHasBoundary) — a solid interior of same-owner tiles skips it, so
  // contiguous territory reads as one wash instead of a repeating grid of diamond outlines.
  if (owner != null && !fogged) {
    const isBase = tile?.type === 'base';
    g.lineStyle(0);
    g.beginFill(owner, isBase ? 0.26 : 0.16);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    if (ownerBorder) {
      g.lineStyle(isBase ? 2.4 : 1.6, owner, 0.9);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: 2.2 / tp }));
      g.endFill();
    }
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
    drawCityIcon(g, tile!.mine ?? false, tile!.ally ?? false, tile!.sectmate ?? false, tile!.allySect ?? false, tile!.level ?? 1, tp);
  }

  if (tile && tile.level > 1) {
    // Was the square's top-right corner (tp-6,6); nearest diamond analog is the
    // midpoint of the top→right edge, nudged slightly inward.
    const dotColor = tile.mine ? 0x2266cc
      : tile.ally ? 0x2e8b40
      : tile.sectmate ? SECT_BASE_TINT
      : tile.allySect ? ALLY_SECT_BASE_TINT
      : tile.occupied ? 0xcc2222
      : 0x888888;
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
    // 2026-08-09: re-shot from a front-elevation drawing to a wide-legged 3/4-iso one
    // (design/product/slg-building-art.md) so it reads as filling the tile instead of a
    // thin spindly spike — packed frame is 256×198 (~1.29:1).
    if (!placeBuildingSprite(g, 'icon_watchtower', tp, hh, tp * WATCHTOWER_H, false)) {
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

  // ADR-051 (P5): player-built structure marker (arrowTower / blocker), tinted by the TILE's ownership class
  // (own blue / family green / sect-mate purple / allied-sect amber / enemy red — same convention as the
  // territory wash, ADR-003 iron rule). Structures can only be built on own/family land (§8-O2), but a
  // sect-mate or allied-sect member can equally build on THEIR own land, so this is a real 5-way distinction
  // from the viewer's side, not just `structure.mine` (kept on the type for "can I demolish this" only, see
  // WorldMapInput).
  if (tile?.structure) {
    const col = tile.mine ? 0x4477cc
      : tile.ally ? 0x46a85a
      : tile.sectmate ? SECT_BASE_TINT
      : tile.allySect ? ALLY_SECT_BASE_TINT
      : 0xcc3333;
    const baseY = hh - 4;
    if (tile.structure.kind === 'arrowTower') {
      // Hand-drawn icon_arrowTower sprite once the atlas is ready (added 2026-08-17, see
      // design/product/slg-building-art.md) — neutral ink like the rest of building_atlas,
      // ownership no longer painted onto the roof; the tile wash underneath carries that now.
      // Falls back to the original geometric tower (ownership-tinted roof, since there's no
      // tile-wash substitute for it in that path) whenever the atlas/frame isn't ready.
      if (!placeBuildingSprite(g, 'icon_arrowTower', tp, hh, tp * ARROWTOWER_H, false)) {
        const towerW = Math.max(4, tp * 0.16);
        const towerH = Math.max(8, tp * 0.42);
        g.lineStyle(1, 0x3a2a18, 0.9);
        g.beginFill(0xe8dcc0, 0.95);
        g.drawRect(-towerW / 2, baseY - towerH, towerW, towerH);
        g.endFill();
        g.lineStyle(0);
        g.beginFill(col, 0.95); // ownership-tinted pointed roof
        g.drawPolygon([-towerW / 2 - 1, baseY - towerH, towerW / 2 + 1, baseY - towerH, 0, baseY - towerH - towerW]);
        g.endFill();
        g.beginFill(0x3a2a18, 0.9); // arrow slit
        g.drawRect(-1, baseY - towerH * 0.62, 2, towerH * 0.3);
        g.endFill();
      }
    } else if (!placeBuildingSprite(g, 'icon_blocker', tp, hh, tp * BLOCKER_H, false, BLOCKER_BASE_F)) {
      // Geometric fallback for whenever the `icon_blocker` atlas frame isn't ready/decoded yet
      // (see icon_watchtower just above for the same pattern). Art landed 2026-08-09 — a wide
      // row of crossed sharpened stakes (design/product/slg-building-art.md); packed frame is
      // 256×88 (~2.9:1).
      const w = Math.max(6, tp * 0.5);
      const h = Math.max(5, tp * 0.22);
      // Same raised base as the sprite path (BLOCKER_BASE_F) so a mid-load atlas swap doesn't
      // make the barricade visibly hop down the tile.
      const blockerBaseY = hh * BLOCKER_BASE_F;
      g.lineStyle(2, col, 0.95);
      g.beginFill(0xe8dcc0, 0.9);
      g.drawRect(-w / 2, blockerBaseY - h, w, h);
      g.endFill();
      g.lineStyle(1.5, col, 0.9); // X-brace
      g.moveTo(-w / 2, blockerBaseY - h); g.lineTo(w / 2, blockerBaseY);
      g.moveTo(w / 2, blockerBaseY - h); g.lineTo(-w / 2, blockerBaseY);
      g.lineStyle(0);
    }
  }
}

/**
 * Add a neutral-ink building sprite from building_atlas, anchored bottom-center just inside
 * the tile's lower vertex so the structure "stands" on the diamond and rises upward.
 * `targetH` is the on-screen pixel height. Returns false (drawing nothing) if the atlas
 * isn't ready or the frame is missing, so callers can fall back. Sprite children are cleaned
 * each redraw by drawTileSlot.
 *
 * `baseF` places the sprite's base that fraction of the diamond's half-height below the tile
 * center; see BLOCKER_BASE_F above for why flat props need a smaller value than tall ones.
 */

export function placeBuildingSprite(
  g: PIXI.Graphics, name: string, tp: number, hh: number, targetH: number, fogged: boolean,
  baseF = 0.72,
): boolean {
  if (!isBuildingAtlasReady()) return false;
  const tex = getBuildingTexture(name);
  if (!tex) return false;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 1);
  sp.scale.set(targetH / tex.height);
  sp.x = 0;
  sp.y = hh * baseF;   // base sits below the tile center, toward the diamond's lower vertex
  sp.alpha = fogged ? 0.5 : 1;
  g.addChild(sp);
  return true;
}

/**
 * Programmatic city icon drawn on capital (base) tiles.
 * Tier 1 (lv 1-2): camp silhouette; Tier 2 (lv 3-5): walled town; Tier 3 (lv 6-8): castle;
 * Tier 4 (lv 9-10): grand citadel. Will be replaced by AI-generated sprites once assets land.
 */

export function drawCityIcon(g: PIXI.Graphics, mine: boolean, ally: boolean, sectmate: boolean, allySect: boolean, lv: number, tp: number): void {
  const tier = lv <= 2 ? 1 : lv <= 5 ? 2 : lv <= 8 ? 3 : 4;
  const ink = mine ? 0x224488
    : ally ? 0x2e8b40
    : sectmate ? SECT_BASE_TINT
    : allySect ? ALLY_SECT_BASE_TINT
    : 0xcc2222;
  const fill = mine ? 0xd5e0f5
    : ally ? 0xd5f0e0
    : sectmate ? 0xe8dcf0
    : allySect ? 0xf5e8c8
    : 0xf5d5d5;
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

/** L2 medium tile: calm terrain fill + ownership wash/border (no motifs at this zoom) + fog. */

export function drawTileL2(g: PIXI.Graphics, fill: number, owner: number | null, fogged: boolean, tp: number, ownerBorder = true): void {
  g.lineStyle(0);
  g.beginFill(fill, 0.85);
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();
  if (owner != null && !fogged) {
    // No motif carries the signal at medium zoom, so ownership uses a stronger wash + border
    // to keep the territory map readable while terrain stays visible underneath. Border gated
    // by ownerBorder same as drawTileL1 — L2 tiles are smaller, so the interior-grid problem is
    // if anything worse here.
    g.beginFill(owner, 0.42);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    if (ownerBorder) {
      g.lineStyle(1.4, owner, 0.85);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: 1.6 / tp }));
      g.endFill();
    }
  }
  if (fogged) {
    g.lineStyle(0);
    g.beginFill(FOG_COLOR, 0.3);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
  }
}
