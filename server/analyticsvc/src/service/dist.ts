// analyticsvc query domain: distributions — locale/region, OS, browser, device type, geo country
// and match-badge spread, all counted as distinct devices, plus the startup load-time profile
// (percentiles, not devices).
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): holds its own `cols`/`now`, no shared base, no cross-domain calls — assembled by
// composition in ../service.ts.

import { AnalyticsCollections } from '../db';
import {
  RegionRow, OsRow, BadgeDistRow, BrowserRow, DeviceTypeRow, WebViewRow, GeoRow, LoadTimeRow,
  LOAD_TIME_BUCKET_MS, LOAD_TIME_PHASES, SessionDurationRow, SESSION_DURATION_BUCKET_SEC, ChurnSceneRow,
  dayStart,
} from './defs';

/**
 * Read a percentile off a cumulative histogram: the upper bound of the first bucket whose running
 * total reaches `p` of the population. Exact to the bucket width, and never interpolated — an
 * interpolated value would suggest a precision the buckets do not have.
 *
 * Generic over the upper-bound field name (`key`) so the same implementation serves any unit —
 * queryLoadTime's `lt_ms` buckets and querySessionDurationDist's `lt_sec` ones alike.
 */
function percentileFromBuckets<K extends string>(buckets: ({ count: number } & Record<K, number>)[], key: K, total: number, p: number): number {
  if (total === 0) return 0;
  const target = total * p;
  let seen = 0;
  for (const b of buckets) {
    seen += b.count;
    if (seen >= target) return b[key];
  }
  return buckets[buckets.length - 1]?.[key] ?? 0;
}

export class DistService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number,
  ) {}

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

  /** Browser distribution (A9-9): unique device count by server-derived browser (from session_start). */
  async queryBrowserDist(days: number): Promise<BrowserRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { browser: '$browser', device: '$device_id' } } },
      { $group: { _id: '$_id.browser', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ browser: r._id || 'unknown', devices: r.devices }));
  }

  /**
   * In-app WebView distribution (2026-08-24): unique device count by host app, with ordinary browser
   * traffic bucketed as `none`.
   *
   * Reported separately from `browser` rather than replacing it — see parseUserAgent for why. The
   * bucket worth watching is anything but `none`: those sessions run under much tighter memory
   * ceilings and are killed rather than shown an error, so a crash rate that looks unremarkable
   * overall can be concentrated almost entirely here.
   */
  async queryWebViewDist(days: number): Promise<WebViewRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { webview: '$webview', device: '$device_id' } } },
      { $group: { _id: '$_id.webview', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ webview: r._id || 'none', devices: r.devices }));
  }

  /** Device-type distribution (A9-9): mobile / tablet / desktop, server-derived from UA at ingest. */
  async queryDeviceTypeDist(days: number): Promise<DeviceTypeRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { device_type: '$device_type', device: '$device_id' } } },
      { $group: { _id: '$_id.device_type', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ device_type: r._id || 'unknown', devices: r.devices }));
  }

  /** Geo (country) distribution (A9-9): unique device count by IP-derived country. Raw IPs are never stored. */
  async queryGeoDist(days: number): Promise<GeoRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { country: '$geo_country', device: '$device_id' } } },
      { $group: { _id: '$_id.country', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ country: r._id || 'unknown', devices: r.devices }));
  }

  /**
   * Load-time profile per platform (ANALYTICS_DESIGN §5.1b) — percentiles of the total, the mean of
   * each phase, and the number of launches that never finished loading at all.
   *
   * **Percentiles come from a histogram, not from `$percentile`.** `load_time.props.total_ms` is
   * rounded into {@link LOAD_TIME_BUCKET_MS} buckets in the aggregation and the percentiles are read
   * off the cumulative counts here. That costs 100ms of precision and buys two things: memory bounded
   * by the number of distinct buckets rather than by the number of launches (a `$push` of every value
   * risks the 16MB document limit on a busy week), and no dependency on a MongoDB version — and it
   * produces the histogram the ops page wants anyway, which an exact percentile operator would not.
   *
   * `abandoned` is the other half of the measurement and is computed from the same two events rather
   * than from a timeout: a session that emitted `boot` and never `load_time` closed the page while
   * the loading screen was up. Those players reach no scene, click nothing and appear nowhere else.
   */
  async queryLoadTime(days: number): Promise<LoadTimeRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);

    // Per-phase sum AND count, rather than $avg or $push: the count has to be per phase, because a
    // phase missing from a platform (WeChat reports no network phases) must be left out of its own
    // mean instead of being averaged in as zero — and $push would accumulate one sub-document per
    // event, which is exactly the unbounded growth the histogram exists to avoid.
    const phaseAccumulators = Object.fromEntries(
      LOAD_TIME_PHASES.flatMap((p) => [
        [`${p}_sum`, { $sum: { $cond: [{ $isNumber: `$props.${p}` }, `$props.${p}`, 0] } }],
        [`${p}_n`, { $sum: { $cond: [{ $isNumber: `$props.${p}` }, 1, 0] } }],
      ]),
    );

    const hist = await this.cols.events
      .aggregate<{ _id: { platform: string; bucket: number }; count: number } & Record<string, number>>([
        { $match: { ts: { $gte: since }, event: 'load_time', 'props.total_ms': { $type: 'number' } } },
        {
          $group: {
            _id: {
              platform: '$platform',
              // $ceil, not $floor: the bucket label is an inclusive upper bound ("this many launches
              // finished in at most lt_ms"), so a launch of exactly 100ms belongs to the 100ms bucket
              // and not to the 100–200ms one. With $floor every exact multiple lands one bucket too
              // high, which shifts every percentile up by a bucket.
              bucket: { $ceil: { $divide: ['$props.total_ms', LOAD_TIME_BUCKET_MS] } },
            },
            count: { $sum: 1 },
            ...phaseAccumulators,
          },
        },
        { $sort: { '_id.platform': 1 as const, '_id.bucket': 1 as const } },
      ])
      .toArray();

    const abandoned = await this.abandonedByPlatform(since);

    const byPlatform = new Map<string, { buckets: Map<number, number>; samples: number; sums: Map<string, { sum: number; n: number }> }>();
    for (const row of hist) {
      const platform = row._id.platform || 'unknown';
      let agg = byPlatform.get(platform);
      if (!agg) {
        agg = { buckets: new Map(), samples: 0, sums: new Map() };
        byPlatform.set(platform, agg);
      }
      const upper = row._id.bucket * LOAD_TIME_BUCKET_MS;
      agg.buckets.set(upper, (agg.buckets.get(upper) ?? 0) + row.count);
      agg.samples += row.count;
      for (const phase of LOAD_TIME_PHASES) {
        const n = row[`${phase}_n`] ?? 0;
        if (n === 0) continue;
        const cur = agg.sums.get(phase) ?? { sum: 0, n: 0 };
        cur.sum += row[`${phase}_sum`] ?? 0;
        cur.n += n;
        agg.sums.set(phase, cur);
      }
    }

    const rows: LoadTimeRow[] = [];
    for (const [platform, agg] of byPlatform) {
      const buckets = [...agg.buckets.entries()].sort((a, b) => a[0] - b[0]).map(([lt_ms, count]) => ({ lt_ms, count }));
      const avg: Record<string, number> = {};
      for (const [phase, { sum, n }] of agg.sums) avg[phase] = Math.round(sum / n);
      rows.push({
        platform,
        samples: agg.samples,
        p50_ms: percentileFromBuckets(buckets, 'lt_ms', agg.samples, 0.5),
        p75_ms: percentileFromBuckets(buckets, 'lt_ms', agg.samples, 0.75),
        p90_ms: percentileFromBuckets(buckets, 'lt_ms', agg.samples, 0.9),
        p95_ms: percentileFromBuckets(buckets, 'lt_ms', agg.samples, 0.95),
        avg,
        buckets,
        abandoned: abandoned.get(platform) ?? 0,
      });
    }
    // Platforms that only ever produced abandoned launches still deserve a row — that is the worst
    // result this query can report, and dropping it would read as "no data" instead.
    for (const [platform, count] of abandoned) {
      if (byPlatform.has(platform)) continue;
      rows.push({ platform, samples: 0, p50_ms: 0, p75_ms: 0, p90_ms: 0, p95_ms: 0, avg: {}, buckets: [], abandoned: count });
    }
    return rows.sort((a, b) => b.samples - a.samples);
  }

  /** Sessions per platform that emitted `boot` and never `load_time` — see {@link queryLoadTime}. */
  private async abandonedByPlatform(since: Date): Promise<Map<string, number>> {
    const rows = await this.cols.events
      .aggregate<{ _id: string; abandoned: number }>([
        { $match: { ts: { $gte: since }, event: { $in: ['boot', 'load_time'] } } },
        {
          $group: {
            _id: { session: '$session_id', platform: '$platform' },
            booted: { $max: { $cond: [{ $eq: ['$event', 'boot'] }, 1, 0] } },
            loaded: { $max: { $cond: [{ $eq: ['$event', 'load_time'] }, 1, 0] } },
          },
        },
        { $match: { booted: 1, loaded: 0 } },
        { $group: { _id: '$_id.platform', abandoned: { $sum: 1 } } },
      ])
      .toArray();
    return new Map(rows.map((r) => [r._id || 'unknown', r.abandoned]));
  }

  /**
   * Post-match badge/title distribution (ANALYTICS_DESIGN §5.8): how often each `hero` badge is the
   * one awarded, split by mode (pvp_ranked / pvp_friendly / campaign …) and result (win/loss/draw).
   * Answers "is a single badge dominating for everyone" — the calibration-health signal for the
   * ResultScene REF_* constants. Counts matches (events), not devices; one row per (mode,result,badge).
   */
  async queryBadgeDist(days: number): Promise<BadgeDistRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'match_badges' } },
      { $group: {
        _id: { mode: '$props.mode', result: '$props.result', badge: '$props.hero' },
        count: { $sum: 1 },
      } },
      { $sort: { count: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: { mode?: string; result?: string; badge?: string }; count: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({
      mode: r._id.mode || 'unknown',
      result: r._id.result || 'unknown',
      badge: r._id.badge || 'none',
      count: r.count,
    }));
  }

  /**
   * Session-length distribution per platform (RETENTION_LAUNCH_PLAN.md §2 supplementary query):
   * `sessions.duration_sec` was already written at ingest (ingest.ts, from `session_end`'s
   * `props.duration_sec`) but had no query reading it until now. Percentile histogram, same
   * reasoning and shape as {@link queryLoadTime} — long-tailed distribution, bounded memory, no
   * `$percentile` version dependency — just seconds instead of milliseconds.
   */
  async querySessionDurationDist(days: number): Promise<SessionDurationRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const hist = await this.cols.sessions
      .aggregate<{ _id: { platform: string; bucket: number }; count: number }>([
        { $match: { started_at: { $gte: since }, duration_sec: { $type: 'number' } } },
        {
          $group: {
            _id: {
              platform: '$platform',
              // $ceil (not $floor): see queryLoadTime's identical bucket note — an exact-multiple
              // duration belongs to its own inclusive-upper-bound bucket, not the next one up.
              bucket: { $ceil: { $divide: ['$duration_sec', SESSION_DURATION_BUCKET_SEC] } },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.platform': 1 as const, '_id.bucket': 1 as const } },
      ])
      .toArray();

    const byPlatform = new Map<string, { buckets: Map<number, number>; samples: number }>();
    for (const row of hist) {
      const platform = row._id.platform || 'unknown';
      let agg = byPlatform.get(platform);
      if (!agg) {
        agg = { buckets: new Map(), samples: 0 };
        byPlatform.set(platform, agg);
      }
      const upper = row._id.bucket * SESSION_DURATION_BUCKET_SEC;
      agg.buckets.set(upper, (agg.buckets.get(upper) ?? 0) + row.count);
      agg.samples += row.count;
    }

    const rows: SessionDurationRow[] = [];
    for (const [platform, agg] of byPlatform) {
      const buckets = [...agg.buckets.entries()].sort((a, b) => a[0] - b[0]).map(([lt_sec, count]) => ({ lt_sec, count }));
      rows.push({
        platform,
        samples: agg.samples,
        p50_sec: percentileFromBuckets(buckets, 'lt_sec', agg.samples, 0.5),
        p75_sec: percentileFromBuckets(buckets, 'lt_sec', agg.samples, 0.75),
        p90_sec: percentileFromBuckets(buckets, 'lt_sec', agg.samples, 0.9),
        p95_sec: percentileFromBuckets(buckets, 'lt_sec', agg.samples, 0.95),
        buckets,
      });
    }
    return rows.sort((a, b) => b.samples - a.samples);
  }

  /**
   * Last-scene-before-churn distribution (RETENTION_LAUNCH_PLAN.md §2 supplementary query): count of
   * `churn_signal` events by the scene the player was on when it fired (ANALYTICS_DESIGN §5.6 —
   * `props.scene`). Not a funnel — a scene can appear any number of times per session, so this
   * counts churn EVENTS, not distinct devices, answering "where do sessions actually end" rather than
   * "how many players reach this scene".
   */
  async queryChurnLastScene(days: number): Promise<ChurnSceneRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'churn_signal' } },
      { $group: { _id: '$props.scene', count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id?: string; count: number }>(pipeline).toArray();
    return rows.map((r) => ({ scene: r._id || 'unknown', count: r.count }));
  }
}
