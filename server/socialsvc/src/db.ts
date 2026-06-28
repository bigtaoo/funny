// socialsvc 专属库工厂（nw_social，SOCIAL_SVC_DESIGN §3）。
// P1 集合：families / familyMembers / familyMessages（无 worldId）。
// P2 集合：friendEdges / friendRequests / blockList / conversations / chatMessages / mails。
import { MongoClient, Db, Collection } from 'mongodb';
import type { FamilyRole } from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC } from '@nw/shared';

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

export interface SocialCollections {
  families: Collection<FamilyDoc>;
  familyMembers: Collection<FamilyMemberDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
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

  const collections: SocialCollections = { families, familyMembers, familyMessages };

  async function ensureIndexes(): Promise<void> {
    // families: TAG 全局唯一
    await families.createIndex({ tag: 1 }, { unique: true });
    await families.createIndex({ leaderId: 1 });

    // familyMembers: 按 familyId 查成员
    await familyMembers.createIndex({ familyId: 1 });

    // familyMessages: 分页查询 + TTL 自清
    await familyMessages.createIndex({ familyId: 1, ts: -1 });
    await familyMessages.createIndex(
      { ts: 1 },
      { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC },
    );
  }

  return {
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
