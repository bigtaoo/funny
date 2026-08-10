// Mongo client factory + collection handles (SERVER_API.md §5, META_DESIGN.md §6.3).
// Deploy with a single-node replica set to unlock cross-collection transactions; wallet/delivery use single-document atomic updates.
//
// Split 2026-08-10 (server.md "单文件 500 行收敛", independent-function-modules shape — this file was a
// collection of interface declarations with zero shared state, the lowest-risk split candidate per the
// priority doc): doc definitions live in mongo/*Docs.ts, one file per business domain, each self-contained
// (types + its own ensureXIndexes(...) taking only the specific Collection<T> params it needs — no
// dependency on the Collections type, so there's no risk of a domain-file ↔ collections.ts import cycle).
// mongo/collections.ts holds the Collections/MongoHandle interfaces; mongo/client.ts holds
// createMongo/sanitizeMongoUri/ensureIndexes (which just calls each domain's ensureXIndexes in the
// original file's order). This file is a thin re-export shell — external `from '@nw/shared'` / `from
// './mongo'` import paths are unchanged.
export * from './mongo/accountDocs';
export * from './mongo/matchDocs';
export * from './mongo/integrityDocs';
export * from './mongo/commsDocs';
export * from './mongo/inventoryDocs';
export * from './mongo/balanceDocs';
export * from './mongo/miscDocs';
export * from './mongo/collections';
export * from './mongo/client';
