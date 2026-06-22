// Mongo client 工厂 + 集合句柄（SERVER_API.md §5、META_DESIGN.md §6.3）。
// 部署配单节点副本集解锁跨集合事务；钱包/发货走单文档原子更新。
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type { SaveData } from './types';
import type { StatKey } from './achievements';
import type { LadderSeasonDoc } from './season';
import type { ChatRegion } from './chatFilter';
import { CHAT_RETENTION_SEC } from './social';

// —— 集合文档形状 ——
export interface SaveDoc {
  _id: string; // accountId
  save: SaveData;
  rev: number;
}

export interface AccountDoc {
  _id: string; // accountId
  createdAt: number;
  // —— 凭证（每种可选，至少一条）——
  deviceId?: string; // 匿名设备（稀疏唯一）
  openid?: string; // 微信（稀疏唯一）
  password?: {
    // 邮箱/用户名密码（ACCOUNT_DESIGN §2.2）
    loginId: string; // 规范化的 email/username（稀疏唯一）
    hash: string; // scrypt（shared/password.ts）
  };
  oauth?: { provider: string; sub: string }[]; // 第三方（provider+sub 唯一，SA-2）
  // —— 资料 ——
  displayName?: string;
  /** 9 位数字公开 id（全局唯一，玩家交流/投诉用）。首次鉴权时惰性生成。 */
  publicId?: string;
  /**
   * 合规地区码（SOC10）。auth 时由 `Accept-Language` 头惰性推断并刷新（best-effort）。
   * 私聊敏感词按发送方此字段选词表；缺省 / 旧账号无此字段 → `'global'`（仅基础词表）。
   */
  region?: ChatRegion;
}

/**
 * 是否匿名：仅挂 device、无任何可恢复凭证（password/oauth/wx）。
 * 联机/商店/充值要求 isAnonymous=false（ACCOUNT_DESIGN §2.2）。计算得出不落库，避免漂移。
 */
export function isAnonymousAccount(doc: AccountDoc): boolean {
  return !doc.openid && !doc.password && !(doc.oauth && doc.oauth.length > 0);
}

// gachaHistory / walletLog / iapReceipts 已迁出 meta 库（S5，COMMERCIAL_DESIGN §8.1）：
// 钱包/流水/抽卡历史/充值票据现在是 commercial 服务的专属库 `notebook_wars_commercial`
// 的 wallets/ledger/orders/recharges/gachaHistory。meta 不再持有这几张表。

/**
 * Inline replay (S1-RP): seed + config + non-empty frame log, no state.
 * Mirrors `contracts/replay.proto`; `frames[].cmds[].commands` are BSON binary
 * (opaque game.proto bytes — the server never decodes them, M12).
 */
export interface MatchReplayDoc {
  engineVersion: number;
  mode: string;
  seed: string;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: unknown }[] }[];
  meta: { recordedAt: number; winner: number };
}

export interface MatchDoc {
  roomId: string;
  mode: string;
  seed: string;
  /**
   * 归档时快照每方身份 + ELO 结算结果（战绩历史 `GET /match/history` 用）。
   * `displayName`/`publicId` 是归档当刻的快照（事后改名不回填）；`eloDelta`/`eloAfter`
   * 仅 ranked 且成功结算时存在（friendly / 作废局缺省）。
   */
  players: {
    side: number;
    accountId: string;
    displayName?: string;
    publicId?: string;
    eloDelta?: number;
    eloAfter?: number;
  }[];
  winner: number;
  reason: string;
  hashOk: boolean;
  /** Pointer to externally-stored replay (large matches); reserved, not yet used. */
  replayRef?: string;
  /** Embedded replay (small matches) — the retained frame log, zero extra cost. */
  replay?: MatchReplayDoc;
  /**
   * 对等裁判定罪标记（Phase C）：ranked hash 不一致经第三方无头复算后，与裁判结果
   * 不符的一方判负 + 记此标记。`judgeAccountId` 为复算裁判（审计用）。
   */
  cheat?: { side: number; accountId: string; judgeAccountId?: string };
  /**
   * 成就 PvP 统计上报值（S9-7 L2 离线抽查的比对基准，仅 ranked）。per-side：side 号转字符串 key →
   * 该方 L1 清洗后**已入账**的 kill/cast 增量（即 `statDeltaForSide` 算出并 accrue 的值）。
   * `pvp.wins` 不含（服务器自算、不审计）。服务器侧只读、不进 wire schema、不下发。
   */
  reportedStats?: Record<string, Partial<Record<StatKey, number>>>;
  /**
   * 成就 PvP 统计离线抽查结果（S9-7 L2，§4.4）。**存在即幂等闸**——抽查批只查 `audited` 缺省的局。
   * `verdict`：`clean`=上报与复算一致 / `overclaim`=有方超报（已回滚 + 升档 + 入审查队列）/
   * `skipped`=无裁判可裁/复算失败/旧引擎（benefit-of-doubt，不定罪）。`overclaim` 记 per-side 实际回滚量。
   */
  audited?: {
    ts: number;
    verdict: 'clean' | 'overclaim' | 'skipped';
    judgeAccountId?: string;
    overclaim?: Record<string, Partial<Record<StatKey, number>>>;
  };
  ts: number;
}

/** 广告每日 cap 计数（S5-5，meta 权威，不放客户端同步段防刷）。_id = `${accountId}:${dayKey}`。 */
export interface AdsDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string;
  count: number;
  ts: number;
}

/**
 * 大局录像外置存储（S1-RP）：当内嵌帧日志过大（超阈值）时，replay 落此独立集合、
 * `MatchDoc.replayRef = roomId` 指向这里，使 `matches` 文档保持精简、列表/战绩查询快。
 * `GET /match/{roomId}/replay` 取录像时先看 `MatchDoc.replay`（内嵌），缺则回退此集合。
 * （仍是 Mongo BSON binary，非外部对象存储 / S3——那是后续 infra 决策，见 META_TASKS S1-RP。）
 */
export interface ReplayBlobDoc {
  _id: string; // roomId
  replay: MatchReplayDoc;
  ts: number;
}

/** PvE 每日发材料通关次数计数（服务器权威，防刷）。_id = `${accountId}:${dayKey}`。 */
export interface PveDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string;
  rewardedClears: number;
  ts: number;
}

/**
 * PvE 通关录像抽检复算记录（PVE_INTEGRITY §8.6 L1）。被抽中的通关先记此（材料未发、progress/stars
 * 已写），客户端补传录像 → 经 gateway 第三方无头复算 → 复算星数 ≥ 声称才发材料。status：
 * `pending`=等录像、`verified`=复算通过已发、`unverified`=无裁判可裁(benefit-of-doubt 已发)、
 * `rejected`=复算不符未发(可疑)。`pveUpgrades` 是结算当刻服务器权威蓝图快照（复算用，防漂移）。
 */
export interface PveVerificationDoc {
  _id: string; // verifyId（uuid）
  accountId: string;
  levelId: string;
  /** 客户端声称的星数（待复算校验）。 */
  claimedStars: number;
  /** @deprecated S3-2 快照，S12 起由 unitLevels 替代（旧记录保留兼容）。 */
  pveUpgrades: Record<string, number>;
  /** S12 结算当刻服务器权威 unitLevels 快照（复算蓝图）。 */
  unitLevels?: Record<string, number>;
  /** 触发原因（审计）：first | anomaly | sample。 */
  reason: string;
  status: 'pending' | 'verified' | 'unverified' | 'rejected';
  /** 复算得到的星数（verified/rejected 时存）。 */
  judgedStars?: number;
  judgeAccountId?: string;
  ts: number;
}

/**
 * 成就 PvP 统计反作弊审查队列（S9-7 L2/L3，ACHIEVEMENT_DESIGN §4.4）。离线抽查复算实锤某方
 * 超报 kill/cast → 回滚超报 + 升 statSuspicion + 记此条供运维后台（OPS）人工复核/封禁。
 * 业务库（meta），由 admin 经 `GET /internal/anticheat/reviews` 代理读取（admin 库物理隔离）。
 * `_id = `${roomId}:${accountId}``：每局每作弊方一条，天然幂等（防重复回滚）。
 */
export interface AntiCheatReviewDoc {
  _id: string; // `${roomId}:${accountId}`
  roomId: string;
  accountId: string;
  publicId?: string; // 归档当刻快照（OPS 展示）
  side: number;
  reported: Partial<Record<StatKey, number>>; // 该方上报值
  authoritative: Partial<Record<StatKey, number>>; // 裁判复算权威值
  overclaim: Partial<Record<StatKey, number>>; // 理论超报量（reported - authoritative）
  rolledBack: Partial<Record<StatKey, number>>; // 实际回滚量（0 下限钳制后）
  suspicionAfter: number; // 升档后该账号 statSuspicion
  judgeAccountId?: string; // 复算裁判（审计）
  status: 'open' | 'reviewed';
  ts: number;
}

// —— 社交系统集合（S6，SOCIAL_DESIGN §3）——

/** 有向好友边：双向好友 = 两条边。查「我的好友」按 owner 点查（SOC6）。 */
export interface FriendEdgeDoc {
  _id: string; // `${owner}:${friend}`（friendEdgeId）
  owner: string;
  friend: string;
  since: number;
  alias?: string; // owner 私有备注名
}

export interface FriendRequestDoc {
  _id: string; // uuid
  from: string; // accountId
  to: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  message?: string;
  createdAt: number;
  resolvedAt?: number;
}

/** 有向拉黑边（屏蔽对方的好友申请 + 私聊）。 */
export interface BlockDoc {
  _id: string; // `${owner}:${target}`（blockId）
  owner: string;
  target: string;
  ts: number;
}

/** 私聊会话（SOC4）。convId = conversationId(a,b)。 */
export interface ConversationDoc {
  _id: string; // convId
  members: [string, string]; // accountId 对
  lastBody?: string;
  lastFrom?: string;
  lastTs: number;
  unread: Record<string, number>; // accountId → 未读数
}

export interface ChatMessageDoc {
  _id: string; // uuid
  convId: string;
  from: string; // accountId
  body: string;
  kind: 'text' | 'system';
  // BSON Date（非 epoch number）：Mongo TTL 只过期 Date 字段。写入端存 new Date(ts)，
  // 读出时转回 number 建 ChatMessageView。排序/分页（before=<epoch>）按 Date 比较亦正确。
  ts: Date;
}

export interface MailAttachmentDoc {
  // 'material' → SaveData.materials 养成统一池（SLG8）；'item' → inventory.items 泛用桶。
  kind: 'coins' | 'item' | 'skin' | 'material';
  id?: string;
  count?: number;
}

/** 邮件（SOC5）：每收件人一份；附件领取经 commercial 幂等（claimOrderId）。 */
export interface MailDoc {
  _id: string; // uuid
  to: string; // accountId（收件人）
  from: 'system' | string; // 'system' 或发件人 accountId
  fromName?: string;
  subject: string;
  body: string;
  attachments?: MailAttachmentDoc[];
  createdAt: number;
  // BSON Date（非 epoch number）：Mongo TTL 只过期 Date 字段，到期绝对时间（expireAfterSeconds:0）。
  // 写入端存 new Date(createdAt + MAIL_DEFAULT_TTL_SEC*1000)，读出转 number 建 MailView。
  expireAt: Date;
  readAt?: number;
  claimedAt?: number;
  claimOrderId?: string; // 领取幂等（commercial orderId）
}

/**
 * 装备操作幂等账本（E2，EQUIPMENT_DESIGN §18.2）：合成/托管等"扣料 + 产/移实例"类操作，
 * 重复请求重放首次结果（不二次扣料、不二次 roll）。_id = idempotencyKey（合成）/ orderId（托管）。
 * TTL 自清（保留近 N 天足够覆盖客户端重试 + worldsvc 退还窗口）。
 */
export interface EquipmentIdemDoc {
  _id: string; // idempotencyKey / orderId
  accountId: string;
  op: 'craft' | 'escrow' | 'enhance' | 'salvage' | 'reforge';
  /**
   * 首次执行结果快照，重放原样回：
   *   craft   → 产出实例（EquipmentInstance）
   *   escrow  → 托管走的实例快照
   *   enhance → { success, instance }（掷骰结果 + 强化后实例，E3）
   *   salvage → { refunded }（返还材料合计，E3）
   */
  result: unknown;
  expireAt: Date; // BSON Date，TTL 锚
}

export interface Collections {
  saves: Collection<SaveDoc>;
  accounts: Collection<AccountDoc>;
  matches: Collection<MatchDoc>;
  adsDaily: Collection<AdsDailyDoc>;
  replayBlobs: Collection<ReplayBlobDoc>;
  pveDaily: Collection<PveDailyDoc>;
  pveVerifications: Collection<PveVerificationDoc>;
  antiCheatReviews: Collection<AntiCheatReviewDoc>;
  // 社交（S6）
  friendEdges: Collection<FriendEdgeDoc>;
  friendRequests: Collection<FriendRequestDoc>;
  blocks: Collection<BlockDoc>;
  conversations: Collection<ConversationDoc>;
  chatMessages: Collection<ChatMessageDoc>;
  mail: Collection<MailDoc>;
  // 装备（E2）
  equipmentIdem: Collection<EquipmentIdemDoc>;
  // 天梯赛季（S11）：全局单文档（_id='current'）
  ladderSeasons: Collection<LadderSeasonDoc>;
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  collections: Collections;
  /** 创建索引（启动时调一次，幂等）。 */
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

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
      `[mongo] 连接 MongoDB 失败 (uri=${sanitizeMongoUri(uri)}, db=${dbName}): ` +
        `${(err as Error).message}. 请确认数据库已启动且连接配置 (NW_MONGO_URI) 正确。`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: Collections = {
    saves: db.collection<SaveDoc>('saves'),
    accounts: db.collection<AccountDoc>('accounts'),
    matches: db.collection<MatchDoc>('matches'),
    adsDaily: db.collection<AdsDailyDoc>('adsDaily'),
    replayBlobs: db.collection<ReplayBlobDoc>('replayBlobs'),
    pveDaily: db.collection<PveDailyDoc>('pveDaily'),
    pveVerifications: db.collection<PveVerificationDoc>('pveVerifications'),
    antiCheatReviews: db.collection<AntiCheatReviewDoc>('antiCheatReviews'),
    friendEdges: db.collection<FriendEdgeDoc>('friendEdges'),
    friendRequests: db.collection<FriendRequestDoc>('friendRequests'),
    blocks: db.collection<BlockDoc>('blocks'),
    conversations: db.collection<ConversationDoc>('conversations'),
    chatMessages: db.collection<ChatMessageDoc>('chatMessages'),
    mail: db.collection<MailDoc>('mail'),
    equipmentIdem: db.collection<EquipmentIdemDoc>('equipmentIdem'),
    ladderSeasons: db.collection<LadderSeasonDoc>('ladderSeasons'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.accounts.createIndex({ openid: 1 }, { sparse: true, unique: true });
    await collections.accounts.createIndex({ deviceId: 1 }, { sparse: true, unique: true });
    // 密码登录 loginId 唯一（SA-1）；oauth provider+sub 唯一（SA-2，预建）。
    await collections.accounts.createIndex(
      { 'password.loginId': 1 },
      { sparse: true, unique: true },
    );
    await collections.accounts.createIndex(
      { 'oauth.provider': 1, 'oauth.sub': 1 },
      { sparse: true, unique: true },
    );
    // 9 位数字公开 id 全局唯一（稀疏，旧账号惰性补）。
    await collections.accounts.createIndex({ publicId: 1 }, { sparse: true, unique: true });
    await collections.matches.createIndex({ ts: -1 });
    // room_id 幂等：gameserver 局末上报重试不重复结算/归档（meta /internal/match/report）。
    await collections.matches.createIndex({ roomId: 1 }, { unique: true });
    // 按玩家查对局/回放历史（S1-RP 分享、ranked 战绩）。
    await collections.matches.createIndex({ 'players.accountId': 1, ts: -1 });
    // 成就反作弊离线抽查（S9-7）：取未审计的 ranked 局、最旧优先 drain backlog。
    await collections.matches.createIndex({ mode: 1, audited: 1, ts: 1 });
    // PvE 抽检记录：按账号 + 时间查（审计 / 清理待结算）。
    await collections.pveVerifications.createIndex({ accountId: 1, ts: -1 });
    // 成就反作弊审查队列（S9-7）：按账号查历史 + open 队列。
    await collections.antiCheatReviews.createIndex({ accountId: 1, ts: -1 });
    await collections.antiCheatReviews.createIndex({ status: 1, ts: -1 });
    // —— 社交（S6，SOCIAL_DESIGN §3）——
    await collections.friendEdges.createIndex({ owner: 1 });
    // 收件箱（待处理申请）+ 防重复申请（同方向去重）。
    await collections.friendRequests.createIndex({ to: 1, status: 1 });
    await collections.friendRequests.createIndex({ from: 1, to: 1 });
    await collections.blocks.createIndex({ owner: 1 });
    // 按参与者拉会话列表（任一成员 + 末条时间倒序）。
    await collections.conversations.createIndex({ members: 1, lastTs: -1 });
    // 按会话分页拉历史。
    await collections.chatMessages.createIndex({ convId: 1, ts: -1 });
    // 私聊消息保留期满自动回收（TTL，SOC4）。
    await collections.chatMessages.createIndex(
      { ts: 1 },
      { expireAfterSeconds: CHAT_RETENTION_SEC },
    );
    // 收件箱（按时间倒序）。
    await collections.mail.createIndex({ to: 1, createdAt: -1 });
    // 邮件到期自动回收（expireAt 是到期绝对时间戳 → expireAfterSeconds:0，SOC5）。
    await collections.mail.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // 装备幂等账本到期自清（E2，expireAt 到期绝对时间 → expireAfterSeconds:0）。
    await collections.equipmentIdem.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // 天梯排行榜：全服 Top100 + 我的名次计数（S11-SE-5）。
    // pvp.seasonNo 先过滤本季，再 elo 倒序取前 100。
    await collections.saves.createIndex(
      { 'save.pvp.seasonNo': 1, 'save.pvp.elo': -1 },
      { name: 'pvp_season_elo' },
    );
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
