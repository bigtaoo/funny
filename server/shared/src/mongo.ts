// Mongo client 工厂 + 集合句柄（SERVER_API.md §5、META_DESIGN.md §6.3）。
// 部署配单节点副本集解锁跨集合事务；钱包/发货走单文档原子更新。
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type { SaveData } from './types';

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

export interface Collections {
  saves: Collection<SaveDoc>;
  accounts: Collection<AccountDoc>;
  matches: Collection<MatchDoc>;
  adsDaily: Collection<AdsDailyDoc>;
  replayBlobs: Collection<ReplayBlobDoc>;
  pveDaily: Collection<PveDailyDoc>;
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
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
