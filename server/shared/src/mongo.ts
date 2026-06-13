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
  openid?: string;
  deviceId?: string;
  createdAt: number;
}

export interface GachaHistoryDoc {
  accountId: string;
  poolId: string;
  itemId: string;
  rarity: string;
  cost: number;
  rev: number;
  ts: number;
}

export interface WalletLogDoc {
  accountId: string;
  delta: number;
  reason: string;
  balAfter: number;
  ts: number;
}

export interface IapReceiptDoc {
  _id: string; // receiptId
  accountId: string;
  granted: number;
  ts: number;
}

export interface MatchDoc {
  roomId: string;
  mode: string;
  seed: string;
  players: unknown;
  winner: number;
  reason: string;
  hashOk: boolean;
  replayRef?: string;
  ts: number;
}

export interface Collections {
  saves: Collection<SaveDoc>;
  accounts: Collection<AccountDoc>;
  gachaHistory: Collection<GachaHistoryDoc>;
  walletLog: Collection<WalletLogDoc>;
  iapReceipts: Collection<IapReceiptDoc>;
  matches: Collection<MatchDoc>;
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  collections: Collections;
  /** 创建索引（启动时调一次，幂等）。 */
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<MongoHandle> {
  const client = new MongoClient(uri, options);
  await client.connect();
  const db = client.db(dbName);
  const collections: Collections = {
    saves: db.collection<SaveDoc>('saves'),
    accounts: db.collection<AccountDoc>('accounts'),
    gachaHistory: db.collection<GachaHistoryDoc>('gachaHistory'),
    walletLog: db.collection<WalletLogDoc>('walletLog'),
    iapReceipts: db.collection<IapReceiptDoc>('iapReceipts'),
    matches: db.collection<MatchDoc>('matches'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.accounts.createIndex({ openid: 1 }, { sparse: true, unique: true });
    await collections.accounts.createIndex({ deviceId: 1 }, { sparse: true, unique: true });
    await collections.gachaHistory.createIndex({ accountId: 1, ts: -1 });
    await collections.walletLog.createIndex({ accountId: 1, ts: -1 });
    await collections.matches.createIndex({ ts: -1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
