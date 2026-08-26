// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Pure interface declarations: the `WorldCollections` handle bag + `WorldMongo` (client/db/
// collections/ensureIndexes/runMigrations/close), no logic here.
import type { MongoClient, Db, Collection } from 'mongodb';
import type { WorldDoc, TileDoc, MapTemplateDoc, MapTemplateRowDoc, MapBaselineRowDoc } from './worldDocs';
import type { PlayerWorldDoc } from './playerDocs';
import type { MarchDoc, SiegeDoc, SiegeDamageDoc, OccupationDoc, StationedDoc } from './combatDocs';
import type { SectDoc, FamilyMessageDoc, SectMessageDoc, NationMessageDoc, NationDoc } from './socialDocs';
import type { CityDoc } from './cityDocs';
import type { SeasonResultDoc, ShardAllocationDoc, ShardTransferDoc } from './seasonDocs';

export interface WorldCollections {
  worlds: Collection<WorldDoc>;
  tiles: Collection<TileDoc>;
  playerWorld: Collection<PlayerWorldDoc>;
  marches: Collection<MarchDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
  sects: Collection<SectDoc>;
  sectMessages: Collection<SectMessageDoc>;
  nationMessages: Collection<NationMessageDoc>;
  sieges: Collection<SiegeDoc>;
  siegeDamage: Collection<SiegeDamageDoc>;
  occupations: Collection<OccupationDoc>;
  stationed: Collection<StationedDoc>;
  nations: Collection<NationDoc>;
  /** ADR-074 P1 wild cities (~64/world) — the besiegeable city entities. */
  cities: Collection<CityDoc>;
  seasonResults: Collection<SeasonResultDoc>;
  shardAllocations: Collection<ShardAllocationDoc>;
  shardTransfers: Collection<ShardTransferDoc>;
  mapTemplates: Collection<MapTemplateDoc>;
  mapTemplateRows: Collection<MapTemplateRowDoc>;
  mapBaselineRows: Collection<MapBaselineRowDoc>;
}

export interface WorldMongo {
  client: MongoClient;
  db: Db;
  collections: WorldCollections;
  ensureIndexes(): Promise<void>;
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}
