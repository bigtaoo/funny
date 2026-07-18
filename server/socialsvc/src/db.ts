// socialsvc dedicated database factory (nw_social, SOCIAL_SVC_DESIGN §3).
// P1 collections: families / familyMembers / familyMessages (no worldId).
// P2 collections: friendEdges / friendRequests / blockList / conversations / chatMessages / mails.
import { MongoClient, Db, Collection } from 'mongodb';
import type { FamilyRole, MailDoc } from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC, CHAT_RETENTION_SEC } from '@nw/shared';

// ── P2 document types (originally in @nw/shared, moved here locally to decouple) ─────────────────────────────

export interface FriendEdgeDoc {
  _id: string;   // friendEdgeId(owner, friend)
  owner: string;
  friend: string;
  since: number;
  alias?: string;
}

export interface FriendRequestDoc {
  _id: string;   // uuid
  from: string;
  to: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  message?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface BlockDoc {
  _id: string;   // blockId(owner, target)
  owner: string;
  target: string;
  ts: number;
}

export interface ConversationDoc {
  _id: string;   // conversationId(a, b)
  members: [string, string];
  lastBody?: string;
  lastFrom?: string;
  lastTs: number;
  unread: Record<string, number>;
}

export interface ChatMessageDoc {
  _id: string;   // uuid
  convId: string;
  from: string;
  body: string;
  kind: 'text' | 'system';
  ts: Date;      // BSON Date (TTL index requires a Date field)
}

// ── Family (SS2/SS3: globally persistent entity, no worldId) ─────────────────────────────

export interface FamilyDoc {
  /** familyId = `fam:{TAG}` (TAG is 2–5 uppercase characters, unique across the entire database). */
  _id: string;
  name: string;
  /** 2–5 uppercase character abbreviation, unique across the entire database (unique index). */
  tag: string;
  leaderId: string;
  memberCount: number;
  /** Family announcement (most recent one). */
  announcement?: string;
  /**
   * Family prosperity (territory count×10 + member count×50 + activity×5).
   * Score maintained by socialsvc; worldsvc reads the mirror value to check the sect-founding threshold.
   */
  prosperity: number;
  /** Prosperity decay anchor in ms (lazy decay, not ticked daily). */
  prosperityUpdatedAt: number;
  /** Season cumulative activity (incremented via worldsvc internal API $inc; scored for territory occupation and combat). */
  activity: number;
  /** Territory tile count (worldsvc-owned mirror, refreshed alongside prosperity; only worldsvc knows tile ownership). */
  territoryCount?: number;
  /** Sect the family currently belongs to (worldsvc-owned mirror; sects are season/world-scoped and live in worldsvc — see SLG_DESIGN §8.2. Written via /internal/family/:familyId/sect). */
  sectId?: string;
  createdAt: number;
  rev: number;
}
// index: { tag: 1 } unique
// index: { leaderId: 1 }

export interface FamilyMemberDoc {
  /** _id = accountId (a player can belong to only one family). */
  _id: string;
  familyId: string;
  accountId: string;
  role: FamilyRole;
  joinedAt: number;
}
// index: { familyId: 1 }

/** A join request awaiting leader/elder approval (replaces the old direct-join flow). */
export interface FamilyJoinRequestDoc {
  /** uuid */
  _id: string;
  familyId: string;
  accountId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
}
// index: { familyId: 1, status: 1 }
// index: { accountId: 1, status: 1 }

/**
 * Family channel message. ts must be a BSON Date (MongoDB TTL only applies to Date fields).
 */
export interface FamilyMessageDoc {
  /** `fm:{familyId}:{ts_epoch}:{seq}` */
  _id: string;
  familyId: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title snapshot at send time (称号); absent if the sender had none. */
  title?: string;
  /** Sender's family name snapshot at send time (家族 — the family itself, since the channel is family-scoped). */
  familyName?: string;
  body: string;
  ts: Date;
}
// index: { familyId: 1, ts: -1 }
// TTL index: { ts: 1 } expireAfterSeconds = FAMILY_MSG_RETENTION_SEC

// ── P2: friends / private chat / mail (migrated from metaserver) ────────────────────────────
// Document structures reuse the Doc types from @nw/shared (consistent with notebook_wars database; migrated as-is).
// index hints (see ensureIndexes):
//   friendEdges:    { owner: 1 } + { _id: 1 } (exact lookup by friendEdgeId)
//   friendRequests: { from: 1, status: 1 } + { to: 1, status: 1 }
//   blockList:      { owner: 1 }
//   conversations:  { members: 1, lastTs: -1 }
//   chatMessages:   { convId: 1, ts: -1 } TTL: { ts: 1 } expireAfterSeconds = CHAT_RETENTION_SEC
//   mails:          { to: 1, createdAt: -1 } + { to: 1, expireAt: 1 } TTL: { expireAt: 1 }

export interface SocialCollections {
  families: Collection<FamilyDoc>;
  familyMembers: Collection<FamilyMemberDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
  familyJoinRequests: Collection<FamilyJoinRequestDoc>;
  // P2
  friendEdges: Collection<FriendEdgeDoc>;
  friendRequests: Collection<FriendRequestDoc>;
  blockList: Collection<BlockDoc>;
  conversations: Collection<ConversationDoc>;
  chatMessages: Collection<ChatMessageDoc>;
  mails: Collection<MailDoc>;
}

export interface SocialMongo {
  collections: SocialCollections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createSocialMongo(uri: string, dbName: string): Promise<SocialMongo> {
  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db(dbName);

  const families = db.collection<FamilyDoc>('families');
  const familyMembers = db.collection<FamilyMemberDoc>('familyMembers');
  const familyMessages = db.collection<FamilyMessageDoc>('familyMessages');
  const familyJoinRequests = db.collection<FamilyJoinRequestDoc>('familyJoinRequests');
  const friendEdges = db.collection<FriendEdgeDoc>('friendEdges');
  const friendRequests = db.collection<FriendRequestDoc>('friendRequests');
  const blockList = db.collection<BlockDoc>('blockList');
  const conversations = db.collection<ConversationDoc>('conversations');
  const chatMessages = db.collection<ChatMessageDoc>('chatMessages');
  const mails = db.collection<MailDoc>('mails');

  const collections: SocialCollections = {
    families, familyMembers, familyMessages, familyJoinRequests,
    friendEdges, friendRequests, blockList, conversations, chatMessages, mails,
  };

  async function ensureIndexes(): Promise<void> {
    // families
    await families.createIndex({ tag: 1 }, { unique: true });
    await families.createIndex({ leaderId: 1 });

    // familyMembers
    await familyMembers.createIndex({ familyId: 1 });

    // familyMessages: auto-expired via TTL
    await familyMessages.createIndex({ familyId: 1, ts: -1 });
    await familyMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });

    // familyJoinRequests
    await familyJoinRequests.createIndex({ familyId: 1, status: 1 });
    await familyJoinRequests.createIndex({ accountId: 1, status: 1 });

    // friendEdges
    await friendEdges.createIndex({ owner: 1 });

    // friendRequests
    await friendRequests.createIndex({ from: 1, status: 1 });
    await friendRequests.createIndex({ to: 1, status: 1 });

    // blockList
    await blockList.createIndex({ owner: 1 });

    // conversations
    await conversations.createIndex({ members: 1, lastTs: -1 });

    // chatMessages: auto-expired via TTL
    await chatMessages.createIndex({ convId: 1, ts: -1 });
    await chatMessages.createIndex({ ts: 1 }, { expireAfterSeconds: CHAT_RETENTION_SEC });

    // mails: auto-expired via TTL
    await mails.createIndex({ to: 1, createdAt: -1 });
    await mails.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  }

  return {
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
