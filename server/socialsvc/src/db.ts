// socialsvc 专属库工厂（nw_social，SOCIAL_SVC_DESIGN §3）。
// P1 集合：families / familyMembers / familyMessages（无 worldId）。
// P2 集合：friendEdges / friendRequests / blockList / conversations / chatMessages / mails。
import { MongoClient, Db, Collection } from 'mongodb';
import type { FamilyRole, FriendEdgeDoc, FriendRequestDoc, BlockDoc, ConversationDoc, ChatMessageDoc, MailDoc } from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC, CHAT_RETENTION_SEC } from '@nw/shared';

// ── 家族（SS2/SS3：全局持久实体，无 worldId）─────────────────────────────

export interface FamilyDoc {
  /** familyId = `fam:{TAG}`（TAG 全大写 2–5 字符，全库唯一）。 */
  _id: string;
  name: string;
  /** 全大写 2–5 字符缩写，全库唯一（unique index）。 */
  tag: string;
  leaderId: string;
  memberCount: number;
  /** 家族公告（最近一条）。 */
  announcement?: string;
  /**
   * 家族繁荣度（领地数×10 + 成员×50 + 活跃×5）。
   * socialsvc 记分值，worldsvc 读镜像判断建宗门门槛。
   */
  prosperity: number;
  /** 繁荣度衰减锚点 ms（惰性衰减，不每日 tick）。 */
  prosperityUpdatedAt: number;
  /** 赛季累计活跃（worldsvc 通过内部 API $inc，占领/战斗计分）。 */
  activity: number;
  createdAt: number;
  rev: number;
}
// index: { tag: 1 } unique
// index: { leaderId: 1 }

export interface FamilyMemberDoc {
  /** _id = accountId（一个玩家只能在一个家族）。 */
  _id: string;
  familyId: string;
  accountId: string;
  role: FamilyRole;
  joinedAt: number;
}
// index: { familyId: 1 }

/**
 * 家族频道消息。ts 须 BSON Date（MongoDB TTL 只对 Date 字段生效）。
 */
export interface FamilyMessageDoc {
  /** `fm:{familyId}:{ts_epoch}:{seq}` */
  _id: string;
  familyId: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: Date;
}
// index: { familyId: 1, ts: -1 }
// TTL index: { ts: 1 } expireAfterSeconds = FAMILY_MSG_RETENTION_SEC

// ── P2：好友 / 私聊 / 邮件（从 metaserver 迁入）────────────────────────────
// 文档结构复用 @nw/shared 中的 Doc 类型（与 notebook_wars 库一致，直接迁移）。
// index hints（见 ensureIndexes）：
//   friendEdges:    { owner: 1 } + { _id: 1 }（friendEdgeId 精确查）
//   friendRequests: { from: 1, status: 1 } + { to: 1, status: 1 }
//   blockList:      { owner: 1 }
//   conversations:  { members: 1, lastTs: -1 }
//   chatMessages:   { convId: 1, ts: -1 } TTL: { ts: 1 } expireAfterSeconds = CHAT_RETENTION_SEC
//   mails:          { to: 1, createdAt: -1 } + { to: 1, expireAt: 1 } TTL: { expireAt: 1 }

export interface SocialCollections {
  families: Collection<FamilyDoc>;
  familyMembers: Collection<FamilyMemberDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
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
  const friendEdges = db.collection<FriendEdgeDoc>('friendEdges');
  const friendRequests = db.collection<FriendRequestDoc>('friendRequests');
  const blockList = db.collection<BlockDoc>('blockList');
  const conversations = db.collection<ConversationDoc>('conversations');
  const chatMessages = db.collection<ChatMessageDoc>('chatMessages');
  const mails = db.collection<MailDoc>('mails');

  const collections: SocialCollections = {
    families, familyMembers, familyMessages,
    friendEdges, friendRequests, blockList, conversations, chatMessages, mails,
  };

  async function ensureIndexes(): Promise<void> {
    // families
    await families.createIndex({ tag: 1 }, { unique: true });
    await families.createIndex({ leaderId: 1 });

    // familyMembers
    await familyMembers.createIndex({ familyId: 1 });

    // familyMessages: TTL 自清
    await familyMessages.createIndex({ familyId: 1, ts: -1 });
    await familyMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });

    // friendEdges
    await friendEdges.createIndex({ owner: 1 });

    // friendRequests
    await friendRequests.createIndex({ from: 1, status: 1 });
    await friendRequests.createIndex({ to: 1, status: 1 });

    // blockList
    await blockList.createIndex({ owner: 1 });

    // conversations
    await conversations.createIndex({ members: 1, lastTs: -1 });

    // chatMessages: TTL 自清
    await chatMessages.createIndex({ convId: 1, ts: -1 });
    await chatMessages.createIndex({ ts: 1 }, { expireAfterSeconds: CHAT_RETENTION_SEC });

    // mails: TTL 自清
    await mails.createIndex({ to: 1, createdAt: -1 });
    await mails.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  }

  return {
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
