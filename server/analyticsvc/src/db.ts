// analyticsvc MongoDB (A9-1).
// Dedicated database notebook_wars_analytics, five collections: events (TTL 90d) / sessions / funnels_daily / boots_daily / tutorial_anon_daily.
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
  /** Host app when the page runs inside an embedded WebView (gsa/facebook/instagram/line/…), absent
   *  for ordinary browser traffic. See parseUserAgent — in-app WebViews were previously indistinguishable
   *  from the browser they embed, which hid the environment class most prone to being killed for memory. */
  webview?: string;
  /** Request IP (X-Forwarded-For / socket) at ingest time — used for account-protection lookups
   * (shared-IP abuse/multi-account detection) as well as the geo_* fields below. */
  ip?: string;
  /** Server-derived from `ip` via geoip-lite. */
  geo_country?: string;
  geo_region?: string;
  geo_city?: string;
}

/** Session summary document. 90-day TTL on `started_at` (2026-07-27 audit finding: this was genuinely
 * permanent while `events`, the collection it's derived from, already expires at 90 days — same window here). */
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
  /** Host app when the page runs inside an embedded WebView (gsa/facebook/instagram/line/…), absent
   *  for ordinary browser traffic. See parseUserAgent — in-app WebViews were previously indistinguishable
   *  from the browser they embed, which hid the environment class most prone to being killed for memory. */
  webview?: string;
  ip?: string;
  geo_country?: string;
  geo_region?: string;
  geo_city?: string;
}

/**
 * Daily launch counter, one document per (date, platform) — the denominator for everyone who opens
 * the game and never answers the age / consent gates (ANALYTICS_DESIGN §3.6b).
 *
 * Deliberately **not** an `events` document and deliberately not per-device: `GET /analytics/config`
 * is the one request every launch makes before those gates, and it carries no identity at all — no
 * device id, no JWT, and this collection stores no IP. A counter is the most that can be recorded
 * there without consent, and it is enough: compare it with the `session_start` **event count** (also
 * one per launch) and the difference is the cohort that left at a gate. Comparing it with distinct
 * devices would be comparing launches with people.
 *
 * Permanent, like funnels_daily — it is a couple of numbers a day, and the whole point is the long trend.
 */
export interface BootDailyDoc {
  _id: string; // `${date}|${platform}`
  date: string;
  platform: string;
  count: number;
  /**
   * Of those launches, the ones a player who refused analytics made ("essentials only",
   * ANALYTICS_DESIGN §3.6c). Same three columns as `count` — date, platform, a number — written by
   * the same unauthenticated request, because refusing telemetry cannot be reported *as* telemetry.
   *
   * Without it these launches are indistinguishable from the age/consent-gate bounce: both reach the
   * counter and neither ever reaches `session_start`. Absent on documents written before 2026-09-21.
   */
  declined?: number;
  updated_at: Date;
}

/**
 * Daily anonymous tutorial-step counter, one document per (date, platform, step) — how far into the
 * first minute the launches WITHOUT analytics consent got (COMPLIANCE_GLOBAL §3.3, written by
 * `GET /analytics/config?t=<step>`). Same privacy position as {@link BootDailyDoc}: a date, a build
 * target, an allow-listed step key and a number — no device id, no account, no IP. Permanent for the
 * same reason too: a handful of numbers a day whose value is the trend.
 */
export interface TutorialAnonDailyDoc {
  _id: string; // `${date}|${platform}|${step}`
  date: string;
  platform: string;
  step: string;
  count: number;
  updated_at: Date;
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
  boots_daily: Collection<BootDailyDoc>;
  tutorial_anon_daily: Collection<TutorialAnonDailyDoc>;
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
  const boots_daily = db.collection<BootDailyDoc>('boots_daily');
  const tutorial_anon_daily = db.collection<TutorialAnonDailyDoc>('tutorial_anon_daily');

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
    await events.createIndex({ webview: 1, ts: -1 }, { sparse: true });
    await events.createIndex({ geo_country: 1, ts: -1 }, { sparse: true });
    await events.createIndex({ ip: 1, ts: -1 }, { sparse: true });
    // Account-deletion purge: pre-login events carry only a device id, so the purge deletes by
    // device_id — which had no index on events at all (sessions has {device_id, started_at} below).
    await events.createIndex({ device_id: 1 });
    // sessions: TTL 90 days, same window as events (2026-07-27 audit finding: previously permanent)
    await sessions.createIndex({ started_at: -1 });
    await sessions.createIndex({ started_at: 1 }, { expireAfterSeconds: 7776000 });
    await sessions.createIndex({ device_id: 1, started_at: -1 });
    await sessions.createIndex({ ip: 1, started_at: -1 }, { sparse: true }); // account-protection: find sessions sharing an IP
    // Account-deletion purge deletes a player's sessions by user_id, which nothing else queried.
    await sessions.createIndex({ user_id: 1 });
    // funnels_daily
    await funnels_daily.createIndex({ date: -1, platform: 1 });
    // boots_daily: the _id is already `${date}|${platform}`, so the upsert needs no index of its
    // own; this one serves the range scan the boot_funnel query does.
    await boots_daily.createIndex({ date: -1 });
    // tutorial_anon_daily: same shape of _id-keyed upsert; this serves boot_funnel's range scan.
    await tutorial_anon_daily.createIndex({ date: -1 });
  }

  return {
    client,
    db,
    collections: { events, sessions, funnels_daily, boots_daily, tutorial_anon_daily },
    ensureIndexes,
    close: () => client.close(),
  };
}
