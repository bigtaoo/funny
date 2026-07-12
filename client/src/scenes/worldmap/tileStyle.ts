// Tile styling — colors + ownership/terrain classification. Extracted from WorldMapScene.
// Two orthogonal signals, kept visually separate to preserve the hand-drawn notebook feel
// (project_art_direction) and stop the map reading as a confetti of colored blocks:
//   • TERRAIN / RESOURCE → a calm, near-paper base fill. Resource *type* is carried by the
//     hand-drawn motif sprite (drawResMotif at L1), NOT by a saturated background. RES_COLORS
//     are heavily desaturated (paper-adjacent, warm/neutral) so they never masquerade as an
//     ownership hue and only whisper the biome zone at the L2/L3 overview.
//   • OWNERSHIP → the only strong color, applied as a translucent wash + colored border/accent
//     (see ownerTint + drawTileL1/L2), following the "enemy blue, player red" convention:
//     own = red ink, enemy = blue ink, family-ally = green ink.

import type { WorldTileView } from '../../net/WorldApiClient';
import { proceduralTile, biomeMixAt } from '@nw/shared';
import type { ObstacleKind } from '@nw/shared';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';

// Terrain base colors (unoccupied) — desaturated, paper-cohesive; specials stay distinct but muted.
export const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8, // paper-white empty land
  resource:   0xf0ece0, // resource fallback → near-paper (type is carried by the motif, not the fill)
  familyKeep: 0xe8d29a, // strategic point / chokepoint — muted warm amber
  center:     0xf0dfa0, // world center — soft gold
  obstacle:   0xc4bdb0, // impassable terrain (mountains/rivers) — muted stone grey
  bridge:     0xb9c6d2, // river crossing (bridge) — cool stone-blue (reads as the river it spans)
  plankway:   0xb2967a, // mountain crossing (plankway) — warm timber brown (reads as planks over rock)
  stronghold: 0x9a7a6a, // stronghold (G8): muted stone brown (was dark red — avoided clash with own-territory red)
  territory:  0xf5f0e8, // fallback (ownership is drawn as wash/border, not as the fill)
  base:       0xf5f0e8,
};

// Resource biome tints — deliberately faint & paper-adjacent. The real type signal is the motif;
// these only hint the biome zone at overview zooms. Kept warm/neutral so none reads as red/blue/green.
export const RES_COLORS: Record<string, number> = {
  ink:      0xe4e2ea, // faint cool grey-lavender
  paper:    0xf0ebdd, // faint warm cream
  graphite: 0xe2e0da, // faint neutral grey
  metal:    0xe4e8e6, // faint cool steel
  sticker:  0xefe4ea, // faint warm rose-grey
};

/**
 * Per-terrain opacity for the L1 ground texture fill. Most terrain draws near-opaque
 * (DEFAULT); the busy obstacle weaves (mountain / river) draw a little softer so they still
 * recede into the paper rather than pulling the eye to the map edges where impassable bands
 * cluster. Nudged 0.5→0.68 (2026-07-08): 0.5 washed the hand-drawn rock/wave texture almost
 * flat — mountains read as a pale wash next to the crisp opaque land tiles — so obstacles
 * now keep visible texture while staying below land. Any terrain not listed uses the DEFAULT.
 */
export const TERRAIN_TEX_ALPHA_DEFAULT = 0.95; // 0.85→0.95 (2026-07-11): land was too washed out against the pale paper — see legibility pass
export const TERRAIN_TEX_ALPHA: Partial<Record<TerrainTextureName, number>> = {
  // 0.68→0.8→0.92 (2026-07-12): at the small on-screen tile sizes most zoom levels actually use,
  // the fine pencil rock/wave linework anti-aliases down to near-flat before the paper-blend even
  // applies — 0.8 then let another 20% of paper leak through on top of that, washing obstacle tiles
  // to a flat color block indistinguishable from a plain fill (reported: "where's the river/mountain
  // art, all I see is a color block"). 0.92 keeps a sliver of "recede into paper" softness vs land's
  // 0.95 while recovering most of the contrast the paper-blend was eating.
  terrain_mountain: 0.92,
  terrain_river:    0.92,
};

/**
 * Per-terrain color TINT for the L1 ground texture — PixiJS multiplies it into the texture fill.
 * The terrain atlas is hand-drawn GREY PENCIL ON PALE PAPER, i.e. effectively a luminance mask:
 * multiplying a light, paper-adjacent hue tints the open paper of each tile toward that hue while
 * the darker pencil strokes stay dark — a faint "colored-pencil" wash that adds warmth and terrain
 * legibility WITHOUT turning the map into saturated color blocks, preserving the hand-drawn notebook
 * look (project_art_direction). Tints are deliberately high-luminance & desaturated; retune the whole
 * map's palette by nudging these. 0xffffff (the default) = no tint = the raw grey art.
 */
// Per-resource biome tint for the ground of a `resource` tile — applied at L1 by drawTileL1 so
// same-resource zones read as faint colored regions (三战-style terrain legibility) beneath the
// per-level motif. Deliberately high-luminance & paper-adjacent: the wash whispers the biome
// without competing with the motif or masquerading as an ownership hue. Retune the biome palette
// by nudging these. Must match the map-editor's tileStyle.ts RES_TEX_TINT (SLG map render parity).
// Tried deepening these 2026-07-11 for the legibility pass, then reverted: resType is assigned
// per-tile independently (no spatial clustering), so a strong per-type ground tint reads as
// dense pink/blue-grey confetti rather than legible biome zones — the exact "地图像彩色纸屑"
// problem the 2026-07-08 pass already fixed once (see DESIGN.md). Left faint; resource-type
// legibility now comes from the motif icon's raised alpha floor instead (see drawResMotif).
export const RES_TEX_TINT: Record<string, number> = {
  paper:    0xf1e6c0, // warm straw
  ink:      0xc6cfe8, // cool periwinkle
  graphite: 0xd2d4d0, // neutral graphite grey
  metal:    0xc7dccb, // steel mint
  sticker:  0xf0cfe1, // soft rose
};

function lerpHexColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff;
  const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff;
  const r = Math.round(r1 + (r2 - r1) * t), g = Math.round(g1 + (g2 - g1) * t), b = Math.round(b1 + (b2 - b1) * t);
  return (r << 16) | (g << 8) | b;
}

/**
 * Ground tint for a resource tile at (x,y), blended across biome-zone boundaries instead of hard-cut
 * (2026-07-11 continuity pass — see biomeMixAt in @nw/shared). Deep inside a zone this equals plain
 * `RES_TEX_TINT[biomeAt(...)]`; near a boundary it fades to the neighboring zone's tint over ~10 tiles.
 */
export function biomeGroundTint(x: number, y: number, seed: number): number {
  const mix = biomeMixAt(x, y, seed);
  return mix.t === 0 ? RES_TEX_TINT[mix.a]! : lerpHexColor(RES_TEX_TINT[mix.a]!, RES_TEX_TINT[mix.b]!, mix.t);
}

export const TERRAIN_TEX_TINT_DEFAULT = 0xffffff;
export const TERRAIN_TEX_TINT: Partial<Record<TerrainTextureName, number>> = {
  terrain_grass:      0xc8dcb0, // generic land / grass — warm sage, deepened 2026-07-11 for zone legibility
  terrain_river:      0x8fbadb, // river — cool blue, deepened 2026-07-12 (was 0xa9cbe0 at 0.8 alpha; paired with the 0.92 alpha bump so the wave art keeps some contrast against land)
  terrain_mountain:   0xa2a7b0, // mountain — cool stone grey, deepened 2026-07-12 (was 0xb3b7bd at 0.8 alpha; paired with the 0.92 alpha bump)
  terrain_keep:       0xe0c481, // chokepoint keep — warm amber, deepened 2026-07-11
  terrain_center:     0xe6d377, // world center — soft gold, deepened 2026-07-11
  terrain_stronghold: 0xba9a80, // NPC stronghold — muted stone brown, deepened 2026-07-11
};

export const MINE_TINT      = 0xe69090; // own territory (light red ink)
export const MINE_BASE_TINT = 0xcc3333; // own capital (deep red ink)
export const ENEMY_TINT     = 0x90a8e6; // enemy territory (light blue ink)
export const ENEMY_BASE_TINT= 0x4477cc; // enemy capital (deep blue ink)
export const ALLY_TINT      = 0x9cd6a4; // family-ally territory (light green ink — G5 friendly third color)
export const ALLY_BASE_TINT = 0x46a85a; // family-ally capital (deep green ink)
export const FOG_COLOR      = 0xc9c2b2; // fog of war (light warm paper-grey, thin overlay on terrain)
export const CLOUD_COLOR    = 0xcfc7b6; // off-map cloud/mist veil (warm paper-grey) — hides the blank paper beyond the map edge
export const ALLY_SECT_BORDER = 0xe6a817; // allied-sect territory yellow border (amber gold, G5; marks without shared vision, §8.2)

/** Ownership color for the wash/border overlay, or null when the tile is unowned. */
export function ownerTint(tile: WorldTileView): number | null {
  if (tile.mine)     return tile.type === 'base' ? MINE_BASE_TINT : MINE_TINT;
  if (tile.ally)     return tile.type === 'base' ? ALLY_BASE_TINT : ALLY_TINT;
  if (tile.occupied) return tile.type === 'base' ? ENEMY_BASE_TINT : ENEMY_TINT;
  return null;
}

/** Terrain/resource base fill (no ownership) — desaturated, paper-cohesive. */
export function terrainFill(tile: WorldTileView): number {
  if (tile.type === 'resource' && tile.resType) {
    return RES_COLORS[tile.resType] ?? TERRAIN_COLORS.resource!;
  }
  return TERRAIN_COLORS[tile.type] ?? TERRAIN_COLORS.neutral!;
}

/**
 * Hand-drawn ground texture for a tile type (design/product/slg-terrain-art.md §0/§3).
 * `obstacle` covers both mountain and river (SLG_DESIGN §3.1). When the tile carries an explicit
 * {@link ObstacleKind} (painted in the editor, or set by proceduralTile for its ridge/river/branch
 * bands) that art is used verbatim; otherwise a deterministic per-tile hash picks one of the two
 * doodle variants so a legacy contiguous obstacle band doesn't look monotone.
 */
/** Ground texture for a bare obstacle kind (river/mountain), no per-tile hash fallback needed since
 * the caller (obstacleShoreAt) always knows the neighboring obstacle's exact kind. Used for the
 * edge "shore" wash — see drawTileL1. Must stay in lockstep with the map-editor's tileStyle.ts. */
export function obstacleTextureName(kind: ObstacleKind): TerrainTextureName {
  return kind === 'river' ? 'terrain_river' : 'terrain_mountain';
}

export function terrainTextureName(type: string, tx: number, ty: number, obstacleKind?: ObstacleKind): TerrainTextureName {
  switch (type) {
    case 'obstacle':    return obstacleKind === 'river' ? 'terrain_river'
                             : obstacleKind === 'mountain' ? 'terrain_mountain'
                             : (tx * 31 + ty * 17) % 2 === 0 ? 'terrain_mountain' : 'terrain_river';
    // Crossings render the terrain they span as the GROUND (river / mountain); the bridge/plankway
    // building itself is drawn on top by the building-sprite layer (see tileGraphics/city rendering).
    case 'bridge':      return 'terrain_river';
    case 'plankway':    return 'terrain_mountain';
    case 'familyKeep':  return 'terrain_keep';
    case 'center':      return 'terrain_center';
    case 'stronghold':  return 'terrain_stronghold';
    default:            return 'terrain_grass'; // neutral / territory / base / resource default ground
  }
}

/**
 * L3 overview block color: ownership dominates when owned (the overview exists for
 * situational awareness — whose land is where), otherwise the calm terrain fill.
 */
export function tileColor(tile: WorldTileView): number {
  return ownerTint(tile) ?? terrainFill(tile);
}

/** Procedural terrain color for uncached tiles (no network request; purely local computation). */
export function proceduralTileColor(worldId: string, x: number, y: number): number {
  const p = proceduralTile(worldId, x, y);
  if (p.type === 'resource' && p.resType) return RES_COLORS[p.resType] ?? TERRAIN_COLORS.resource!;
  return TERRAIN_COLORS[p.type] ?? TERRAIN_COLORS.neutral!;
}
