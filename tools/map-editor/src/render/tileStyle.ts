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

// Ground-texture opacity + colored-pencil tint — mirrors the game client's tileStyle.ts so the
// editor preview matches what players see. The terrain atlas is grey pencil on pale paper, so
// multiplying a light hue (TERRAIN_TEX_TINT) washes each tile toward that color while strokes stay
// dark; mountain/river also drop to 0.5 alpha so obstacle weaves recede into the paper.
export const TERRAIN_TEX_ALPHA_DEFAULT = 0.85;
export const TERRAIN_TEX_ALPHA: Partial<Record<TerrainTextureName, number>> = {
  terrain_mountain: 0.5,
  terrain_river:    0.5,
};

// Per-resource biome tint for the ground texture of a plain `resource` tile. Since the resource
// motif overlay was removed (see tileGraphics.drawEditorTile), the biome is now read straight off the
// tinted paper: each resource washes its tiles a soft, distinct, still-paper-cohesive hue so paper /
// ink / graphite / metal / sticker zones are locatable at a glance without the old motif carpet.
// familyKeep/stronghold tiles are NOT tinted here — they keep their landmark terrain tint. Must match
// the game client's tileStyle.ts (SLG map render parity).
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
  terrain_river:      0xcfe0ec, // river — faint cool blue (also at 0.5 alpha)
  terrain_mountain:   0xdccbb4, // mountain — faint warm taupe (also at 0.5 alpha)
  terrain_gate:       0xe9dabb, // pass / bridge — soft tan
  terrain_keep:       0xeeddb0, // chokepoint keep — warm amber
  terrain_center:     0xf2e6ad, // world center — soft gold
  terrain_stronghold: 0xcdb8a6, // NPC stronghold — muted stone brown
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
