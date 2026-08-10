// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). The actual Mongo client factory: connect, build the `WorldCollections` handle bag, wire up
// `ensureIndexes` (delegates to each domain file's own ensureXIndexes, called in the original file's order
// — cross-collection index-creation order carries no behavioral meaning) and `runMigrations`.
import { MongoClient, Db, type MongoClientOptions } from 'mongodb';
import type { WorldCollections, WorldMongo } from './collections';
import { type WorldDoc, type TileDoc, type MapTemplateDoc, type MapTemplateRowDoc, type MapBaselineRowDoc, ensureWorldIndexes } from './worldDocs';
import { type PlayerWorldDoc, ensurePlayerIndexes, migratePlayerWorldTroopPool } from './playerDocs';
import {
  type MarchDoc,
  type SiegeDoc,
  type SiegeDamageDoc,
  type OccupationDoc,
  type StationedDoc,
  ensureCombatIndexes,
} from './combatDocs';
import {
  type SectDoc,
  type FamilyMessageDoc,
  type SectMessageDoc,
  type NationMessageDoc,
  type NationDoc,
  ensureSocialIndexes,
} from './socialDocs';
import { type SeasonResultDoc, type ShardAllocationDoc, type ShardTransferDoc, ensureSeasonIndexes } from './seasonDocs';

export async function createWorldMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<WorldMongo> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    const safeUri = uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
    console.error(
      `[world-mongo] MongoDB connection failed (uri=${safeUri}, db=${dbName}): ` +
        `${(err as Error).message}. Ensure the database is running and NW_WORLD_MONGO_URI/NW_MONGO_URI is correct.`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: WorldCollections = {
    worlds: db.collection<WorldDoc>('worlds'),
    tiles: db.collection<TileDoc>('tiles'),
    playerWorld: db.collection<PlayerWorldDoc>('playerWorld'),
    marches: db.collection<MarchDoc>('marches'),
    familyMessages: db.collection<FamilyMessageDoc>('familyMessages'),
    sects: db.collection<SectDoc>('sects'),
    sectMessages: db.collection<SectMessageDoc>('sectMessages'),
    nationMessages: db.collection<NationMessageDoc>('nationMessages'),
    sieges: db.collection<SiegeDoc>('sieges'),
    siegeDamage: db.collection<SiegeDamageDoc>('siegeDamage'),
    occupations: db.collection<OccupationDoc>('occupations'),
    stationed: db.collection<StationedDoc>('stationed'),
    nations: db.collection<NationDoc>('nations'),
    seasonResults: db.collection<SeasonResultDoc>('seasonResults'),
    shardAllocations: db.collection<ShardAllocationDoc>('shardAllocations'),
    shardTransfers: db.collection<ShardTransferDoc>('shardTransfers'),
    mapTemplates: db.collection<MapTemplateDoc>('mapTemplates'),
    mapTemplateRows: db.collection<MapTemplateRowDoc>('mapTemplateRows'),
    mapBaselineRows: db.collection<MapBaselineRowDoc>('mapBaselineRows'),
  };

  async function ensureIndexes(): Promise<void> {
    await ensureWorldIndexes(
      collections.worlds,
      collections.tiles,
      collections.mapTemplates,
      collections.mapTemplateRows,
      collections.mapBaselineRows,
    );
    await ensurePlayerIndexes(collections.playerWorld);
    await ensureCombatIndexes(
      collections.marches,
      collections.sieges,
      collections.siegeDamage,
      collections.occupations,
      collections.stationed,
    );
    await ensureSocialIndexes(
      collections.sects,
      collections.familyMessages,
      collections.sectMessages,
      collections.nationMessages,
      collections.nations,
    );
    await ensureSeasonIndexes(collections.seasonResults, collections.shardAllocations);
  }

  /** One-time data migrations run once at boot after ensureIndexes. See playerDocs.ts for the migration itself. */
  async function runMigrations(): Promise<void> {
    await migratePlayerWorldTroopPool(collections.playerWorld);
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    runMigrations,
    close: () => client.close(),
  };
}
