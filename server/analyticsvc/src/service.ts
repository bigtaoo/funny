// analyticsvc 业务逻辑（A9-2 / A9-3）。
import type { AnalyticsCollections, EventDoc, SessionDoc } from './db';

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
    upgrade:        { sample: 1.0 },
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

export class AnalyticsService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getConfig(): AnalyticsConfig {
    return getConfig();
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
