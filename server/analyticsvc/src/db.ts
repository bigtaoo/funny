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
  /** Raw client-reported UA/screen fields (web only; absent for wechat/crazygames). */
  ua?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
  /** Server-derived from `ua` at ingest time (never trust a client-supplied browser name). */
  browser?: string;
  device_type?: 'mobile' | 'tablet' | 'desktop';
  /** Request IP (X-Forwarded-For / socket) at ingest time — used for account-protection lookups
   * (shared-IP abuse/multi-account detection) as well as the geo_* fields below. */
  ip?: string;
  /** Server-derived from `ip` via geoip-lite. */
  geo_country?: string;
  geo_region?: string;
  geo_city?: string;
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
  ua?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
  browser?: string;
  device_type?: 'mobile' | 'tablet' | 'desktop';
  ip?: string;
  geo_country?: string;
  geo_region?: string;
  geo_city?: string;
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
    await events.createIndex({ event: 1, 'props.level_id': 1, ts: -1 });
    await events.createIndex({ session_id: 1 });
    await events.createIndex({ browser: 1, ts: -1 }, { sparse: true });
    await events.createIndex({ device_type: 1, ts: -1 }, { sparse: true });
    await events.createIndex({ geo_country: 1, ts: -1 }, { sparse: true });
    await events.createIndex({ ip: 1, ts: -1 }, { sparse: true });
    // sessions
    await sessions.createIndex({ started_at: -1 });
    await sessions.createIndex({ device_id: 1, started_at: -1 });
    await sessions.createIndex({ ip: 1, started_at: -1 }, { sparse: true }); // account-protection: find sessions sharing an IP
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
