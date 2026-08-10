// worldsvc dedicated database factory (S8-0, SLG_DESIGN §14.3). Database name notebook_wars_world, physically isolated from meta/commercial/admin.
// 7 collections: worlds / tiles / playerWorld / marches / sieges / sects / nations. Family identity/roster lives in socialsvc (see db.ts note above SectDoc);
// auction collections moved to auctionsvc's own database (§9 task 6).
// Write pattern reuses single-document atomics + rev optimistic locking (META_DESIGN §6.3). Sparse storage: only occupied/modified tiles are persisted;
// neutral tiles are computed on-the-fly by shared proceduralTile() and not stored (key to §14.2 scale).
//
// Split 2026-08-10 (server.md "单文件 500 行收敛", independent-function-modules shape, same pattern as
// shared/src/mongo.ts): doc definitions live in db/*Docs.ts, one file per business domain (world/map,
// player/city, combat/march, social/nation, season), each self-contained (types + its own
// ensureXIndexes(...) taking only the specific Collection<T> params it needs). db/collections.ts holds the
// WorldCollections/WorldMongo interfaces; db/client.ts holds createWorldMongo/ensureIndexes/runMigrations.
// This file is a thin re-export shell — external `from '../db'` / `from './db'` import paths are unchanged.
export * from './db/worldDocs';
export * from './db/playerDocs';
export * from './db/combatDocs';
export * from './db/socialDocs';
export * from './db/seasonDocs';
export * from './db/collections';
export * from './db/client';
