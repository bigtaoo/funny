// analyticsvc business logic (A9-2 / A9-3 / A9-6).
import type { AnalyticsCollections, EventDoc, FunnelDailyDoc, SessionDoc } from './db';

// ─── Collection config (A9-2, phase-1 hardcoded; phase-2 DB-configurable) ─────────────────────────────

export interface EventConfig {
  enabled?: boolean;
  sample?: number;
}

export interface AnalyticsConfig {
  enabled: boolean;
  defaultSample: number;
  events: Record<string, EventConfig>;
}

export const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  defaultSample: 0.1,
  events: {
    session_start:  { sample: 1.0 },
    session_end:    { sample: 1.0 },
    screen_view:    { sample: 0.05 },
    game_start:     { sample: 1.0 },
    game_end:       { sample: 1.0 },
    level_attempt:  { sample: 1.0 },
    level_complete: { sample: 1.0 },
    level_abandon:  { sample: 1.0 },
    card_play:      { enabled: false },
    shop_open:      { sample: 0.5 },
    shop_buy:       { sample: 1.0 },
    shop_close:     { sample: 1.0 },
    gacha_draw:     { sample: 1.0 },
    recharge:       { sample: 1.0 },
    upgrade:        { sample: 1.0 },
    friend_add:     { sample: 1.0 },
    pvp_room_create:{ sample: 1.0 },
    pvp_match_start:{ sample: 1.0 },
    // Achievement funnel (S9-8, ANALYTICS_DESIGN §5.7): unlock toast → view wall → claim; 100% sampled (low-frequency, high-value).
    achievement_unlock_toast: { sample: 1.0 },
    achievement_view_wall:    { sample: 1.0 },
    achievement_claim:        { sample: 1.0 },
    tutorial_skip:  { sample: 1.0 },
    login_gate_hit: { sample: 1.0 },
    churn_signal:   { sample: 1.0 },
  },
};

export function getConfig(): AnalyticsConfig {
  return DEFAULT_CONFIG;
}

// ─── Event ingestion (A9-3) ─────────────────────────────────────────────────────────

export interface RawEvent {
  event: string;
  ts: number;
  props?: Record<string, unknown>;
}

export interface EventBatch {
  session_id: string;
  device_id: string;
  platform: string;
  os: string;
  game_version: string;
  locale: string;
  events: RawEvent[];
  /** C5-c GDPR consent flag. Identified users (with a JWT) must set this to true before their events are recorded; anonymous users are exempt (no PII). */
  consent?: boolean;
}

// ─── Query result types (A9-6) ───────────────────────────────────────────────────────

export interface EventCountRow {
  date: string;
  event: string;
  count: number;
}

export interface DauRow {
  date: string;
  dau: number;
}

export interface RegionRow { locale: string; devices: number }
export interface OsRow { os: string; devices: number }
export interface LoginHourRow { hour: number; count: number }
export interface RetentionRow {
  date: string;
  cohort_size: number;
  d1?: number;
  d7?: number;
  d1_rate?: number;
  d7_rate?: number;
}

export interface QueryResult {
  event_counts?: EventCountRow[];
  dau?: DauRow[];
  funnel?: FunnelDailyDoc[];
  region_dist?: RegionRow[];
  os_dist?: OsRow[];
  login_hour?: LoginHourRow[];
  retention?: RetentionRow[];
}

// Funnel step definitions (order defines the conversion chain; the ETL uses the same list when writing funnels_daily).
export const FUNNEL_STEPS = ['session_start', 'game_start', 'level_attempt', 'level_complete'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// Start-of-day timestamp (UTC).
function dayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function toDateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class AnalyticsService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getConfig(): AnalyticsConfig {
    return getConfig();
  }

  // ─── Aggregate queries (A9-6) ─────────────────────────────────────────────────────

  /** Daily count per event type (last N days). */
  async queryEventCounts(days: number): Promise<EventCountRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } },
            event: '$event',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 as const, '_id.event': 1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: { date: string; event: string }; count: number }>(pipeline).toArray();
    return rows.map((r) => ({ date: r._id.date, event: r._id.event, count: r.count }));
  }

  /** Daily active devices (last N days). */
  async queryDau(days: number): Promise<DauRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } },
            device: '$device_id',
          },
        },
      },
      {
        $group: {
          _id: '$_id.date',
          dau: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; dau: number }>(pipeline).toArray();
    return rows.map((r) => ({ date: r._id, dau: r.dau }));
  }

  /** Read pre-aggregated funnel data (last N days, optional platform filter). */
  async queryFunnel(days: number, platform?: string): Promise<FunnelDailyDoc[]> {
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(toDateStr(dayStart(this.now()) - i * 86400_000));
    }
    const filter: Record<string, unknown> = { date: { $in: dates } };
    if (platform) filter['platform'] = platform;
    return this.cols.funnels_daily.find(filter).sort({ date: 1, platform: 1, funnel_step: 1 }).toArray();
  }

  /** ETL: recompute the funnel by platform for the given date (UTC date string) and upsert funnels_daily (A9-7). */
  async runFunnelEtl(dateStr: string): Promise<void> {
    const dayMs = Date.parse(dateStr + 'T00:00:00Z');
    const nextMs = dayMs + 86400_000;

    // Aggregate distinct device_id count per platform × funnel step (each step has its own independent window, not an intersecting funnel).
    const pipeline = [
      { $match: { ts: { $gte: new Date(dayMs), $lt: new Date(nextMs) }, event: { $in: FUNNEL_STEPS as unknown as string[] } } },
      {
        $group: {
          _id: { platform: '$platform', event: '$event', device: '$device_id' },
        },
      },
      {
        $group: {
          _id: { platform: '$_id.platform', event: '$_id.event' },
          count: { $sum: 1 },
        },
      },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: { platform: string; event: string }; count: number }>(pipeline)
      .toArray();

    // Group by platform, compute per-step counts and conversion rates.
    const byPlatform = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const { platform, event } = r._id;
      if (!byPlatform.has(platform)) byPlatform.set(platform, new Map());
      byPlatform.get(platform)!.set(event, r.count);
    }

    const ops: Array<{ filter: Record<string, unknown>; doc: FunnelDailyDoc }> = [];
    for (const [platform, counts] of byPlatform) {
      let prevCount: number | undefined;
      for (const step of FUNNEL_STEPS) {
        const count = counts.get(step) ?? 0;
        const conversion_rate = prevCount !== undefined && prevCount > 0 ? count / prevCount : undefined;
        ops.push({
          filter: { _id: `${dateStr}:${platform}:${step}` },
          doc: { _id: `${dateStr}:${platform}:${step}`, date: dateStr, platform, funnel_step: step, count, conversion_rate },
        });
        prevCount = count;
      }
    }

    // Concurrent upsert (skip when there are 0 rows).
    await Promise.all(
      ops.map(({ filter, doc }) =>
        this.cols.funnels_daily.updateOne(filter, { $set: doc }, { upsert: true }),
      ),
    );
  }

  /** Region distribution: unique device count by locale across all events (last N days). */
  async queryRegionDist(days: number): Promise<RegionRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since } } },
      { $group: { _id: { locale: '$locale', device: '$device_id' } } },
      { $group: { _id: '$_id.locale', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: string; devices: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({ locale: r._id || 'unknown', devices: r.devices }));
  }

  /** Device/OS distribution: unique device count by os from session_start events (last N days). */
  async queryOsDist(days: number): Promise<OsRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { os: '$os', device: '$device_id' } } },
      { $group: { _id: '$_id.os', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: string; devices: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({ os: r._id || 'unknown', devices: r.devices }));
  }

  /** Login-hour distribution: session_start count by UTC hour (last N days, all 24 hours filled). */
  async queryLoginHour(days: number): Promise<LoginHourRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { $hour: '$ts' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: number; count: number }>(pipeline)
      .toArray();
    const byHour = new Map(rows.map((r) => [r._id, r.count]));
    return Array.from({ length: 24 }, (_, h) => ({ hour: h, count: byHour.get(h) ?? 0 }));
  }

  /**
   * D1/D7 rolling retention: fraction of daily active devices in the last N days that are still active on day 1 / day 7.
   * An extra 7-day data window is fetched to allow computing D7 for early cohorts.
   */
  async queryRetention(days: number): Promise<RetentionRow[]> {
    const extraDays = 7;
    const since = new Date(dayStart(this.now()) - (days - 1 + extraDays) * 86400_000);

    // Deduplicate (date, device) → list of distinct active devices per day
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, device: '$device_id' } } },
      { $group: { _id: '$_id.date', devices: { $push: '$_id.device' } } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: string; devices: string[] }>(pipeline)
      .toArray();

    const byDate = new Map<string, Set<string>>();
    for (const r of rows) byDate.set(r._id, new Set(r.devices));

    const result: RetentionRow[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dateMs = dayStart(this.now()) - i * 86400_000;
      const date = toDateStr(dateMs);
      const cohort = byDate.get(date);
      if (!cohort || cohort.size === 0) {
        result.push({ date, cohort_size: 0 });
        continue;
      }
      const d1Set = byDate.get(toDateStr(dateMs + 86400_000));
      const d7Set = byDate.get(toDateStr(dateMs + 7 * 86400_000));
      const d1 = d1Set !== undefined ? [...cohort].filter((d) => d1Set.has(d)).length : undefined;
      const d7 = d7Set !== undefined ? [...cohort].filter((d) => d7Set.has(d)).length : undefined;
      result.push({
        date,
        cohort_size: cohort.size,
        d1,
        d7,
        d1_rate: d1 !== undefined ? d1 / cohort.size : undefined,
        d7_rate: d7 !== undefined ? d7 / cohort.size : undefined,
      });
    }
    return result;
  }

  async ingestEvents(batch: EventBatch, userId: string | undefined): Promise<void> {
    if (!batch.events || batch.events.length === 0) return;

    const docs: EventDoc[] = batch.events.map((e) => ({
      session_id: batch.session_id ?? '',
      user_id: userId,
      device_id: batch.device_id ?? '',
      platform: batch.platform ?? 'web',
      os: batch.os ?? '',
      game_version: batch.game_version ?? '',
      locale: batch.locale ?? '',
      event: String(e.event),
      props: e.props ?? {},
      ts: new Date(typeof e.ts === 'number' ? e.ts : this.now()),
    }));

    // fire-and-forget: w:0 does not wait for disk acknowledgement; a very small amount of event loss is acceptable for analytics data (A9-3 §7.3)
    await this.cols.events.insertMany(docs, { ordered: false, writeConcern: { w: 0 } });

    // session summary upsert (sessions collection, driven by session_start/session_end events)
    const sessionStart = batch.events.find((e) => e.event === 'session_start');
    const sessionEnd = batch.events.find((e) => e.event === 'session_end');

    if (sessionStart && batch.session_id) {
      await this.cols.sessions.updateOne(
        { _id: batch.session_id },
        {
          $setOnInsert: {
            user_id: userId,
            device_id: batch.device_id ?? '',
            platform: batch.platform ?? 'web',
            os: batch.os ?? '',
            started_at: new Date(typeof sessionStart.ts === 'number' ? sessionStart.ts : this.now()),
            scenes_visited: [],
          },
          $inc: { events_count: batch.events.length },
        },
        { upsert: true },
      );
    }

    if (sessionEnd && batch.session_id) {
      const props = sessionEnd.props ?? {};
      await this.cols.sessions.updateOne(
        { _id: batch.session_id },
        {
          $set: {
            ended_at: new Date(typeof sessionEnd.ts === 'number' ? sessionEnd.ts : this.now()),
            ...(typeof props['duration_sec'] === 'number' ? { duration_sec: props['duration_sec'] } : {}),
            ...(Array.isArray(props['scenes_visited']) ? { scenes_visited: props['scenes_visited'] as string[] } : {}),
          },
        },
      );
    }
  }
}
