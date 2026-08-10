// Split from mapgen.ts (2026-08-10, independent function module range 6, part 6/7).
// Map templates (§24, admin-side editor for Layer A / design-time terrain baseline). A template is a
// from-scratch procedural seed (server-generated via proceduralTile) that ops can then hand-tune
// tile-by-tile in the editor. It is NOT runtime state: `TileDoc` overlays (Layer B) still carry
// occupation/building/garrison; a world instance clones a template's tiles as its terrain baseline at
// world-open time (copy, not a live reference — later template edits never retroactively affect a running world).
import type { ObstacleKind, ResourceType, TileType } from '../core';

/** One tile inside a map template — same shape as {@link ProceduralTile} plus its coordinate. */
export interface MapTemplateTile {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** For `type:'obstacle'` only: river vs mountain art (see {@link ObstacleKind}). Round-trips through the editor's publish path. */
  obstacleKind?: ObstacleKind;
}

/** Template metadata (no tile payload — used for the template-picker list in the editor). */
export interface MapTemplateSummary {
  templateId: string;
  width: number;
  height: number;
  /** Bumped on regeneration; lets multiple generations of the same templateId size be told apart if ever reused. */
  version: number;
  tileCount: number;
  /** Whether new worlds currently clone this template as their terrain baseline (§24 "used to create new worlds"). At most one template is active at a time. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Diff-save payload cap (§24 "only upload the tiles changed this time"): guards against an editor bug accidentally re-uploading a whole map. */
export const MAP_TEMPLATE_SAVE_MAX_TILES = 5000;
/** Viewport read cap (editor opens a bbox, not the whole 500×500 template at once). */
export const MAP_TEMPLATE_READ_MAX_TILES = 100_000;
