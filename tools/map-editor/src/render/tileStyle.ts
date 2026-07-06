// Terrain/resource fill colors + texture-name mapping — trimmed from the game client's
// client/src/scenes/worldmap/tileStyle.ts down to the parts the editor needs. The editor only
// ever draws proceduralTile()/rasterizeMapEdits() output (no runtime ownership/fog state), so
// the ownerTint/fog/mine/ally machinery from the client original is dropped entirely.
import type { ObstacleKind, ResourceType, TileType } from '@nw/shared/slg';
import type { TerrainTextureName } from './terrainAtlasLoader';

export const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8,
  resource:   0xf0ece0,
  familyKeep: 0xe8d29a,
  center:     0xf0dfa0,
  obstacle:   0xc4bdb0,
  gate:       0xd8c2a0,
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
    case 'gate':        return 'terrain_gate';
    case 'familyKeep':  return 'terrain_keep';
    case 'center':      return 'terrain_center';
    case 'stronghold':  return 'terrain_stronghold';
    default:            return 'terrain_grass';
  }
}
