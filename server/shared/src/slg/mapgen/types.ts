// Split from mapgen.ts (2026-08-10, independent function module range 6, part 1/7).
// The one type shared across every sibling in this split (terrain/biome/cities all
// return or consume it) + its tiny `obstacle` factory — pulled out on its own so no
// sibling has to reach back into the assembler shell (which would create a cycle).
import type { ObstacleKind, ResourceType, TileType } from '../core';

/** Default attributes for a procedural tile (in an unclaimed neutral world). Once claimed at runtime, the DB document takes precedence. */
export interface ProceduralTile {
  type: TileType;
  /** Resource/tile level 1..SLG_MAP_MAX_LEVEL (higher = more yield and stronger default NPC garrison). */
  level: number;
  /** Resource type (only present for resource / familyKeep tiles). */
  resType?: ResourceType;
  /** For `type:'obstacle'` only: which impassable-terrain art to draw (river vs mountain). Purely visual — see {@link ObstacleKind}. */
  obstacleKind?: ObstacleKind;
}

/** Convenience: an impassable-terrain result tagged with its art kind (river/mountain). Level is always 1 (§4: obstacles have no level). */
export function obstacleTile(kind: ObstacleKind): ProceduralTile {
  return { type: 'obstacle', level: 1, obstacleKind: kind };
}
