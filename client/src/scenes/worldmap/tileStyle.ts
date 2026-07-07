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
import { proceduralTile } from '@nw/shared';
import type { ObstacleKind } from '@nw/shared';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';

// Terrain base colors (unoccupied) — desaturated, paper-cohesive; specials stay distinct but muted.
export const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8, // paper-white empty land
  resource:   0xf0ece0, // resource fallback → near-paper (type is carried by the motif, not the fill)
  familyKeep: 0xe8d29a, // strategic point / chokepoint — muted warm amber
  center:     0xf0dfa0, // world center — soft gold
  obstacle:   0xc4bdb0, // impassable terrain (mountains/rivers) — muted stone grey
  gate:       0xd8c2a0, // pass / bridge (corridor) — soft tan
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
 * (DEFAULT), but the dark, busy obstacle weaves (mountain / river) are pushed down so they
 * recede into the paper instead of pulling the eye to the map edges, where impassable
 * bands tend to cluster. Any terrain not listed uses TERRAIN_TEX_ALPHA_DEFAULT.
 */
export const TERRAIN_TEX_ALPHA_DEFAULT = 0.85; // nudged down from 0.9 so the warm paper breathes through
export const TERRAIN_TEX_ALPHA: Partial<Record<TerrainTextureName, number>> = {
  terrain_mountain: 0.5,
  terrain_river:    0.5,
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
// Per-resource biome tint for the ground texture of a plain `resource` tile. The resource motif
// overlay was removed (see tileGraphics.drawTileL1) because resourceDensity=1.0 (ADR-032) made a motif
// per tile carpet the whole map; the biome is now read straight off the tinted paper — each resource
// washes its tiles a soft, distinct, still-paper-cohesive hue so paper / ink / graphite / metal /
// sticker zones stay locatable. familyKeep/stronghold tiles keep their landmark terrain tint instead.
// Must match the map-editor's tileStyle.ts (SLG map render parity).
export const RES_TEX_TINT: Record<string, number> = {
  paper:    0xf1e6c0, // warm straw
  ink:      0xc6cfe8, // cool periwinkle
  graphite: 0xd2d4d0, // neutral graphite grey
  metal:    0xc7dccb, // steel mint
  sticker:  0xf0cfe1, // soft rose
};

export const TERRAIN_TEX_TINT_DEFAULT = 0xffffff;
export const TERRAIN_TEX_TINT: Partial<Record<TerrainTextureName, number>> = {
  terrain_grass:      0xe2ead4, // generic land / grass — faint warm sage
  terrain_river:      0xcfe0ec, // river — faint cool blue (also drawn at 0.5 alpha → very soft)
  terrain_mountain:   0xdccbb4, // mountain — faint warm taupe (also at 0.5 alpha)
  terrain_gate:       0xe9dabb, // pass / bridge — soft tan
  terrain_keep:       0xeeddb0, // chokepoint keep — warm amber
  terrain_center:     0xf2e6ad, // world center — soft gold
  terrain_stronghold: 0xcdb8a6, // NPC stronghold — muted stone brown
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
export function terrainTextureName(type: string, tx: number, ty: number, obstacleKind?: ObstacleKind): TerrainTextureName {
  switch (type) {
    case 'obstacle':    return obstacleKind === 'river' ? 'terrain_river'
                             : obstacleKind === 'mountain' ? 'terrain_mountain'
                             : (tx * 31 + ty * 17) % 2 === 0 ? 'terrain_mountain' : 'terrain_river';
    case 'gate':        return 'terrain_gate';
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
