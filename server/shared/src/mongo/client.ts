// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). The actual Mongo client factory: connect, build the `Collections` handle bag, wire up
// `ensureIndexes` (delegates to each domain file's own ensureXIndexes, called in the original file's order —
// cross-collection index-creation order carries no behavioral meaning, only same-collection order does, and
// that's preserved inside each domain function).
import { MongoClient, Db, type MongoClientOptions } from 'mongodb';
import type { Collections, MongoHandle } from './collections';
import { type SaveDoc, type AccountDoc, type StaminaDoc, ensureAccountIndexes } from './accountDocs';
import {
  type MatchDoc,
  type ReplayBlobDoc,
  type ReplayShareDoc,
  type StateReplayShareDoc,
  ensureMatchIndexes,
} from './matchDocs';
import {
  type PveVerificationDoc,
  type AntiCheatReviewDoc,
  type PveRejectDoc,
  type AppealDoc,
  ensureIntegrityIndexes,
} from './integrityDocs';
import { type FeedbackDoc, type MailDoc, ensureCommsIndexes } from './commsDocs';
import {
  type CardIdemDoc,
  type EquipmentIdemDoc,
  type InternalGrantOrderDoc,
  type EquipmentInstanceDoc,
  type CardInstanceDoc,
  type SkinInstanceDoc,
  ensureInventoryIndexes,
} from './inventoryDocs';
import { type PvpCardStatDoc, type PvpPlaySequenceDoc, ensureBalanceIndexes } from './balanceDocs';
import { type AdsTokenDoc, type EventDoc, type EventParticipantDoc, ensureMiscIndexes } from './miscDocs';
import type { LadderSeasonDoc, LadderSeasonSnapshotDoc } from '../season';

/** Strip userinfo (user:pass@) from a Mongo URI so it's safe to log. */
function sanitizeMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
}

export async function createMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<MongoHandle> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    // Surface a clear, credential-free message before rethrowing, so a failed
    // DB connection at startup is never a silent/opaque crash regardless of caller.
    console.error(
      `[mongo] Failed to connect to MongoDB (uri=${sanitizeMongoUri(uri)}, db=${dbName}): ` +
        `${(err as Error).message}. Please verify the database is running and the connection config (NW_MONGO_URI) is correct.`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: Collections = {
    saves: db.collection<SaveDoc>('saves'),
    accounts: db.collection<AccountDoc>('accounts'),
    matches: db.collection<MatchDoc>('matches'),
    replayBlobs: db.collection<ReplayBlobDoc>('replayBlobs'),
    pveVerifications: db.collection<PveVerificationDoc>('pveVerifications'),
    antiCheatReviews: db.collection<AntiCheatReviewDoc>('antiCheatReviews'),
    pveRejections: db.collection<PveRejectDoc>('pveRejections'),
    appeals: db.collection<AppealDoc>('appeals'),
    feedback: db.collection<FeedbackDoc>('feedback'),
    replayShares: db.collection<ReplayShareDoc>('replayShares'),
    stateReplayShares: db.collection<StateReplayShareDoc>('stateReplayShares'),
    mail: db.collection<MailDoc>('mail'),
    cardIdem: db.collection<CardIdemDoc>('cardIdem'),
    equipmentIdem: db.collection<EquipmentIdemDoc>('equipmentIdem'),
    internalGrantOrders: db.collection<InternalGrantOrderDoc>('internalGrantOrders'),
    equipmentInstances: db.collection<EquipmentInstanceDoc>('equipmentInstances'),
    cardInstances: db.collection<CardInstanceDoc>('cardInstances'),
    skinInstances: db.collection<SkinInstanceDoc>('skinInstances'),
    ladderSeasons: db.collection<LadderSeasonDoc>('ladderSeasons'),
    ladderSeasonSnapshots: db.collection<LadderSeasonSnapshotDoc>('ladderSeasonSnapshots'),
    adsTokens: db.collection<AdsTokenDoc>('adsTokens'),
    pveStamina: db.collection<StaminaDoc>('pveStamina'),
    events: db.collection<EventDoc>('events'),
    eventParticipants: db.collection<EventParticipantDoc>('eventParticipants'),
    pvpCardStats: db.collection<PvpCardStatDoc>('pvpCardStats'),
    pvpPlaySequences: db.collection<PvpPlaySequenceDoc>('pvpPlaySequences'),
  };

  async function ensureIndexes(): Promise<void> {
    await ensureAccountIndexes(collections.saves, collections.accounts);
    await ensureMatchIndexes(
      collections.matches,
      collections.replayBlobs,
      collections.replayShares,
      collections.stateReplayShares,
    );
    await ensureIntegrityIndexes(
      collections.pveVerifications,
      collections.antiCheatReviews,
      collections.pveRejections,
      collections.appeals,
    );
    await ensureCommsIndexes(collections.feedback, collections.mail);
    await ensureInventoryIndexes(
      collections.cardIdem,
      collections.equipmentIdem,
      collections.internalGrantOrders,
      collections.equipmentInstances,
      collections.cardInstances,
      collections.skinInstances,
    );
    await ensureBalanceIndexes(collections.pvpCardStats);
    await ensureMiscIndexes(collections.adsTokens, collections.events, collections.eventParticipants);
    // ladder season settlement snapshots (L2-1): fetch the season's settlement roster by season (_id is already
    // the ${seasonNo}:${accountId} idempotency key). LadderSeasonDoc/LadderSeasonSnapshotDoc are defined in
    // ../season, not owned by any mongo/*Docs.ts domain file, so their indexes stay here rather than being
    // homed in an artificial "season docs" file.
    await collections.ladderSeasonSnapshots.createIndex({ seasonNo: 1 });
    await collections.ladderSeasonSnapshots.createIndex({ accountId: 1, seasonNo: -1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
