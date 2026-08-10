// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Pure interface declarations: the `Collections` handle bag (one property per Mongo collection,
// typed by the domain files) + `MongoHandle` (client/db/collections/ensureIndexes/close), no logic here.
import type { MongoClient, Db, Collection } from 'mongodb';
import type { SaveDoc, AccountDoc, StaminaDoc } from './accountDocs';
import type { MatchDoc, ReplayBlobDoc, ReplayShareDoc, StateReplayShareDoc } from './matchDocs';
import type { PveVerificationDoc, AntiCheatReviewDoc, PveRejectDoc, AppealDoc } from './integrityDocs';
import type { FeedbackDoc, MailDoc } from './commsDocs';
import type {
  CardIdemDoc,
  EquipmentIdemDoc,
  InternalGrantOrderDoc,
  EquipmentInstanceDoc,
  CardInstanceDoc,
  SkinInstanceDoc,
} from './inventoryDocs';
import type { PvpCardStatDoc, PvpPlaySequenceDoc } from './balanceDocs';
import type { AdsTokenDoc, EventDoc, EventParticipantDoc } from './miscDocs';
import type { LadderSeasonDoc, LadderSeasonSnapshotDoc } from '../season';

export interface Collections {
  saves: Collection<SaveDoc>;
  accounts: Collection<AccountDoc>;
  matches: Collection<MatchDoc>;
  replayBlobs: Collection<ReplayBlobDoc>;
  pveVerifications: Collection<PveVerificationDoc>;
  antiCheatReviews: Collection<AntiCheatReviewDoc>;
  // PvE anti-cheat (S4-4)
  pveRejections: Collection<PveRejectDoc>;
  // player appeals against an active enforcement (CONTENT_MODERATION_DESIGN.md CM10)
  appeals: Collection<AppealDoc>;
  // player free-text feedback (UI_DESIGN.md §4.1.1 / SERVER_API.md §2.13)
  feedback: Collection<FeedbackDoc>;
  // replay shares (S1-RP)
  replayShares: Collection<ReplayShareDoc>;
  // state-stream replay public shares outside the game (REPLAY_SHARE_DESIGN)
  stateReplayShares: Collection<StateReplayShareDoc>;
  // mail (S6-3, system mail still written by metaserver; player mail CRUD migrated to socialsvc)
  mail: Collection<MailDoc>;
  // card roster (CC-2)
  cardIdem: Collection<CardIdemDoc>;
  // equipment (E2)
  equipmentIdem: Collection<EquipmentIdemDoc>;
  // internal grant idempotency ledger (comm-audit-internal-2026-07-28): orderId dedup for /internal/*/grant
  internalGrantOrders: Collection<InternalGrantOrderDoc>;
  // equipment instances, split out of SaveData.equipmentInv (perf, 2026-07-26); _id = instanceId
  equipmentInstances: Collection<EquipmentInstanceDoc>;
  // card instances, split out of SaveData.cardInv (perf, 2026-07-27); _id = instanceId
  cardInstances: Collection<CardInstanceDoc>;
  // skin instances (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08); _id = instanceId
  skinInstances: Collection<SkinInstanceDoc>;
  // ladder seasons (S11): single global document (_id='current')
  ladderSeasons: Collection<LadderSeasonDoc>;
  // ladder season settlement snapshots (L2-1): one entry per account per season, written at season close, also serves as idempotency ledger
  ladderSeasonSnapshots: Collection<LadderSeasonSnapshotDoc>;
  // ad token uniqueness (C2)
  adsTokens: Collection<AdsTokenDoc>;
  // stamina (A4): real-time deduction; _id = accountId
  pveStamina: Collection<StaminaDoc>;
  // time-limited events (B6)
  events: Collection<EventDoc>;
  eventParticipants: Collection<EventParticipantDoc>;
  // PvP balance data pipeline (BALANCE §11): deck-composition win-rate counters
  pvpCardStats: Collection<PvpCardStatDoc>;
  // PvP balance data pipeline P2: sampled replay decode (play sequences)
  pvpPlaySequences: Collection<PvpPlaySequenceDoc>;
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  collections: Collections;
  /** Create indexes (called once at startup, idempotent). */
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}
