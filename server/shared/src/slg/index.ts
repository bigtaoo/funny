// SLG open-world constants / enums / IDs / procedural map generation — single source of truth (SLG_DESIGN.md §14, S8-0).
// Barrel re-export; split into domain modules (god-file split, [[project_godfile_split_pattern]]):
// core (errors/enums/IDs/capacity/base-footprint/gen-knobs/numeric consts), noise (deterministic value noise),
// auction (guardrails + anomaly detection), city (home-city building system), province (nation/province geometry),
// shop (SLG shop items), prosperity (prosperity/season settlement/sharding), mapgen (terrain + proceduralTile + templates),
// march (tile yield + A* pathfinding), siege (siege settlement + vision + siege level + card troop system).
export * from './core';
export * from './auction';
export * from './city';
export {
  NATION_COUNT, NATION_BONUS_PRODUCTION, NATION_BONUS_DEFENSE, CENTER_CAPITAL_IDX, CENTER_CAPITAL_MULT,
  NATION_KIND_BY_IDX, PROVINCE_CORE_RADIUS_RATIO, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO,
  provinceIdxAt, provinceCapitalPositions, capitalIdxAt,
  type NationKind,
} from './province';
export * from './shop';
export * from './prosperity';
export * from './mapgen';
export * from './march';
export * from './siege';
export { worldSeed } from './noise';
