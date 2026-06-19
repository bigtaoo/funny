// analyticsvc 业务逻辑（A9-2 / A9-3 / A9-6）。
import type { AnalyticsCollections, EventDoc, FunnelDailyDoc, SessionDoc } from './db';

// ─── 采集配置（A9-2，一期硬编码；二期改 DB 可配）─────────────────────────────

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
    tutorial_skip:  { sample: 1.0 },
    login_gate_hit: { sample: 1.0 },
    churn_signal:   { sample: 1.0 },
  },
};

export function getConfig(): AnalyticsConfig {
  return DEFAULT_CONFIG;
}

// ─── 事件摄入（A9-3）─────────────────────────────────────────────────────────

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
}

// ─── 查询结果类型（A9-6）───────────────────────────────────────────────────────

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

// 漏斗步骤定义（顺序即转化链，ETL 写入 funnels_daily 用同一列表）。
export const FUNNEL_STEPS = ['session_start', 'game_start', 'level_attempt', 'level_complete'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// 一天起始时间戳（UTC）。
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

  // ─── 聚合查询（A9-6）─────────────────────────────────────────────────────

  /** 各事件类型每日计数（最近 N 天）。 */
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

  /** 每日活跃设备数（最近 N 天）。 */
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

  /** 读取漏斗预聚合数据（最近 N 天，可选 platform 过滤）。 */
  async queryFunnel(days: number, platform?: string): Promise<FunnelDailyDoc[]> {
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(toDateStr(dayStart(this.now()) - i * 86400_000));
    }
    const filter: Record<string, unknown> = { date: { $in: dates } };
    if (platform) filter['platform'] = platform;
    return this.cols.funnels_daily.find(filter).sort({ date: 1, platform: 1, funnel_step: 1 }).toArray();
  }

  /** ETL：为指定日期（UTC date 字符串）按 platform 重算漏斗并 upsert funnels_daily（A9-7）。 */
  async runFunnelEtl(dateStr: string): Promise<void> {
    const dayMs = Date.parse(dateStr + 'T00:00:00Z');
    const nextMs = dayMs + 86400_000;

    // 按 platform × 漏斗步骤聚合 distinct device_id 数（每步独立窗口，非漏斗交集）。
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

    // 按 platform 分组，计算各步骤计数和转化率。
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

    // 并发 upsert（允许 0 行时跳过）。
    await Promise.all(
      ops.map(({ filter, doc }) =>
        this.cols.funnels_daily.updateOne(filter, { $set: doc }, { upsert: true }),
      ),
    );
  }

  /** 地区分布：按 locale 统计独立设备数（最近 N 天所有事件）。 */
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

  /** 设备/OS 分布：按 os 统计独立设备数（最近 N 天 session_start）。 */
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

  /** 登录时段：按 UTC 小时统计 session_start 次数（最近 N 天，填满 0-23）。 */
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
   * D1/D7 滚动留存：最近 N 天每日活跃设备中次日/第7日仍活跃的比例。
   * 多取 7 天数据窗口以便计算早期队列的 D7。
   */
  async queryRetention(days: number): Promise<RetentionRow[]> {
    const extraDays = 7;
    const since = new Date(dayStart(this.now()) - (days - 1 + extraDays) * 86400_000);

    // 去重 (date, device) → 每日独立活跃设备列表
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

    // fire-and-forget：w:0 不等落盘确认，分析数据允许极少量丢失（A9-3 §7.3）
    await this.cols.events.insertMany(docs, { ordered: false, writeConcern: { w: 0 } });

    // session 摘要 upsert（sessions 集合，session_start/session_end 驱动）
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
