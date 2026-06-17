// analyticsvc MongoDB（A9-1）。
// 独立库 notebook_wars_analytics，三个集合：events(TTL 90d) / sessions / funnels_daily。
import { MongoClient, type Db, type Collection } from 'mongodb';

/** 原始事件文档（TTL 90 天）。 */
export interface EventDoc {
  _id?: string;
  session_id: string;
  user_id?: string;
  device_id: string;
  platform: string;
  os: string;
  game_version: string;
  locale: string;
  event: string;
  props: Record<string, unknown>;
  /** BSON Date，TTL index 依赖此字段（expireAfterSeconds=7776000，即 90 天）。 */
  ts: Date;
}

/** 会话摘要文档（永久）。 */
export interface SessionDoc {
  _id: string; // session_id
  user_id?: string;
  device_id: string;
  platform: string;
  os: string;
  started_at: Date;
  ended_at?: Date;
  duration_sec?: number;
  scenes_visited: string[];
  events_count: number;
}

/** 每日漏斗预聚合（永久，ETL job 每小时跑）。 */
export interface FunnelDailyDoc {
  _id?: string;
  date: string;
  platform: string;
  funnel_step: string;
  count: number;
  conversion_rate?: number;
}

export interface AnalyticsCollections {
  events: Collection<EventDoc>;
  sessions: Collection<SessionDoc>;
  funnels_daily: Collection<FunnelDailyDoc>;
}

export interface AnalyticsMongo {
  client: MongoClient;
  db: Db;
  collections: AnalyticsCollections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createAnalyticsMongo(uri: string, dbName: string): Promise<AnalyticsMongo> {
  let client: MongoClient;
  try {
    client = new MongoClient(uri);
    await client.connect();
  } catch (e) {
    const redacted = uri.replace(/:\/\/[^@]*@/, '://***@');
    console.error(`[analyticsvc] MongoDB 连接失败 uri=${redacted} db=${dbName}`, e);
    throw e;
  }

  const db = client.db(dbName);
  const events = db.collection<EventDoc>('events');
  const sessions = db.collection<SessionDoc>('sessions');
  const funnels_daily = db.collection<FunnelDailyDoc>('funnels_daily');

  async function ensureIndexes(): Promise<void> {
    // events：TTL 90 天（7776000s）；查询索引
    await events.createIndex({ ts: -1 });
    await events.createIndex({ ts: 1 }, { expireAfterSeconds: 7776000 });
    await events.createIndex({ event: 1, ts: -1 });
    await events.createIndex({ user_id: 1, ts: -1 }, { sparse: true });
    // sessions
    await sessions.createIndex({ started_at: -1 });
    await sessions.createIndex({ device_id: 1, started_at: -1 });
    // funnels_daily
    await funnels_daily.createIndex({ date: -1, platform: 1 });
  }

  return {
    client,
    db,
    collections: { events, sessions, funnels_daily },
    ensureIndexes,
    close: () => client.close(),
  };
}
