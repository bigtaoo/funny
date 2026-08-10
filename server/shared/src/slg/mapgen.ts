// SLG procedural map generation (core, §14.2 / U2 / U6 initial version; terrain ADR-034 §2.2/§2.3/§3) + map templates (§24).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).
//
// ── Split (2026-08-10, independent function module range 6) ──
// This file was already a set of mutually-independent pure functions (no class, the only shared
// mutable state was `_cityNodeCache`, a module-private memoization map) grouped by concern — a
// textbook independent-function-module split, by domain: `mapgen/{types,biome,terrain,cities,
// levelDist,templates,tileGen}.ts`. `tileGen.ts` holds `proceduralTile` (the top-level per-tile
// classifier composing all the others) and `obstacleShoreAt` (which recurses into `proceduralTile`
// for neighbor tiles) — both had to live "above" terrain.ts/biome.ts/cities.ts/levelDist.ts in the
// import graph rather than beside them, since a sibling file must never import back up into this
// assembler shell (would create a cycle). This file now only re-exports every sibling's public API,
// same shape as the `equipment.ts`/`mongo.ts` precedents.
export * from './mapgen/types';
export * from './mapgen/biome';
export * from './mapgen/terrain';
export * from './mapgen/cities';
export * from './mapgen/templates';
export * from './mapgen/tileGen';
