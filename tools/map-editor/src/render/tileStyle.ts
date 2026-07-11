// Terrain/resource fill colors + texture-name mapping — trimmed from the game client's
// client/src/scenes/worldmap/tileStyle.ts down to the parts the editor needs. The editor only
// ever draws proceduralTile()/rasterizeMapEdits() output (no runtime ownership/fog state), so
// the ownerTint/fog/mine/ally machinery from the client original is dropped entirely.
import { biomeMixAt, type ObstacleKind, type ResourceType, type TileType } from '@nw/shared/slg';
import type { TerrainTextureName } from './terrainAtlasLoader';

export const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8,
  resource:   0xf0ece0,
  familyKeep: 0xe8d29a,
  center:     0xf0dfa0,
  obstacle:   0xc4bdb0,
  bridge:     0xb9c6d2, // river crossing (bridge) — cool stone-blue
  plankway:   0xb2967a, // mountain crossing (plankway) — warm timber brown
  stronghold: 0x9a7a6a,
  territory:  0xf5f0e8,
  base:       0xf5f0e8,
};

export const RES_COLORS: Record<string, number> = {
  ink:      0xe4e2ea,
  paper:    0xf0ebdd,
  graphite: 0xe2e0da,
  metal:    0xe4e8e6,
  sticker:  0xefe4ea,
};

// Ground-texture opacity + colored-pencil tint — mirrors the game client's tileStyle.ts so the
// editor preview matches what players see. The terrain atlas is grey pencil on pale paper, so
// multiplying a light hue (TERRAIN_TEX_TINT) washes each tile toward that color while strokes stay
// dark; mountain/river also drop to 0.5 alpha so obstacle weaves recede into the paper.
export const TERRAIN_TEX_ALPHA_DEFAULT = 0.95; // 0.85→0.95 (2026-07-11 legibility pass). Mirrors the game client's tileStyle.ts (parity).
export const TERRAIN_TEX_ALPHA: Partial<Record<TerrainTextureName, number>> = {
  // 0.5→0.68→0.8 (2026-07-08, 2026-07-11): obstacles now keep visible texture while staying
  // softer than land. Mirrors the game client's tileStyle.ts (parity).
  terrain_mountain: 0.8,
  terrain_river:    0.8,
};

// Per-resource biome tint for the ground of a `resource` tile — applied by drawEditorTile so
// same-resource zones read as faint colored regions (三战-style terrain legibility) beneath the
// per-level motif. Deliberately high-luminance & paper-adjacent so the wash whispers the biome
// without competing with the motif. Mirrors the game client's tileStyle.ts (SLG map render parity).
// Tried deepening these 2026-07-11, then reverted: resType is per-tile random (no spatial
// clustering), so a strong tint reads as confetti, not biome zones. Left faint — see the game
// client's tileStyle.ts for the full note. Mirrors the game client (parity).
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

/** Ground tint blended across biome-zone boundaries (2026-07-11 continuity pass). Mirrors the game
 * client's tileStyle.ts biomeGroundTint (SLG map render parity). */
export function biomeGroundTint(x: number, y: number, seed: number): number {
  const mix = biomeMixAt(x, y, seed);
  return mix.t === 0 ? RES_TEX_TINT[mix.a]! : lerpHexColor(RES_TEX_TINT[mix.a]!, RES_TEX_TINT[mix.b]!, mix.t);
}

export const TERRAIN_TEX_TINT_DEFAULT = 0xffffff;
export const TERRAIN_TEX_TINT: Partial<Record<TerrainTextureName, number>> = {
  terrain_grass:      0xc8dcb0, // generic land / grass — warm sage, deepened 2026-07-11
  terrain_river:      0xa9cbe0, // river — cool blue, deepened 2026-07-11 (also at 0.8 alpha)
  terrain_mountain:   0xb3b7bd, // mountain — cool stone grey, deepened 2026-07-11 (also at 0.8 alpha)
  terrain_keep:       0xe0c481, // chokepoint keep — warm amber, deepened 2026-07-11
  terrain_center:     0xe6d377, // world center — soft gold, deepened 2026-07-11
  terrain_stronghold: 0xba9a80, // NPC stronghold — muted stone brown, deepened 2026-07-11
};

/** Terrain/resource base fill (no ownership) — desaturated, paper-cohesive, same palette as the game client. */
export function terrainFill(type: TileType, resType?: ResourceType): number {
  if (type === 'resource' && resType) return RES_COLORS[resType] ?? TERRAIN_COLORS.resource!;
  return TERRAIN_COLORS[type] ?? TERRAIN_COLORS.neutral!;
}

/** Hand-drawn ground texture for a tile type — identical mapping to the game client's terrainTextureName(). */
export function terrainTextureName(type: string, tx: number, ty: number, obstacleKind?: ObstacleKind): TerrainTextureName {
  switch (type) {
    case 'obstacle':    return obstacleKind === 'river' ? 'terrain_river'
                             : obstacleKind === 'mountain' ? 'terrain_mountain'
                             : (tx * 31 + ty * 17) % 2 === 0 ? 'terrain_mountain' : 'terrain_river';
    // Crossings render the spanned terrain as ground; the bridge/plankway building draws on top (drawEditorTile).
    case 'bridge':      return 'terrain_river';
    case 'plankway':    return 'terrain_mountain';
    case 'familyKeep':  return 'terrain_keep';
    case 'center':      return 'terrain_center';
    case 'stronghold':  return 'terrain_stronghold';
    default:            return 'terrain_grass';
  }
}
