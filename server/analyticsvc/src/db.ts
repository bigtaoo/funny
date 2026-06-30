// analyticsvc MongoDB (A9-1).
// Dedicated database notebook_wars_analytics, three collections: events (TTL 90d) / sessions / funnels_daily.
import { MongoClient, type Db, type Collection } from 'mongodb';

/** Raw event document (TTL 90 days). */
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
  /** BSON Date; the TTL index depends on this field (expireAfterSeconds=7776000, i.e. 90 days). */
  ts: Date;
}

/** Session summary document (permanent). */
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

/** Daily funnel pre-aggregation (permanent; ETL job runs every hour). */
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
    console.error(`[analyticsvc] MongoDB connection failed uri=${redacted} db=${dbName}`, e);
    throw e;
  }

  const db = client.db(dbName);
  const events = db.collection<EventDoc>('events');
  const sessions = db.collection<SessionDoc>('sessions');
  const funnels_daily = db.collection<FunnelDailyDoc>('funnels_daily');

  async function ensureIndexes(): Promise<void> {
    // events: TTL 90 days (7776000s); query indexes
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
