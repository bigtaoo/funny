// analyticsvc query domain: grouped retention — D1–D7 curves for the new-user cohort, sliced by a
// single first-session property (RETENTION_LAUNCH_PLAN.md §2). This is the "why" tool: queryRetention
// (traffic.ts) answers "how much retention", this answers "which players retain better and why".
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): holds its own `cols`/`now`, no shared base, no cross-domain calls — assembled by
// composition in ../service.ts.

import { AnalyticsCollections } from '../db';
import {
  RETENTION_OFFSETS, RetentionOffset, RetentionByDimension, RetentionByRow, dayStart, toDateStr,
} from './defs';

// Session-level fields already computed at ingest (db.ts SessionDoc) vs. fields that only exist on
// individual events and must be derived from the device's first session's event stream.
const SESSION_DOC_DIMENSIONS = new Set<RetentionByDimension>(['browser', 'device_type', 'webview', 'geo_country']);

/** Coarse buckets for `load_time`'s `props.total_ms` — retention grouping wants a handful of readable
 *  buckets, not the 100ms histogram resolution queryLoadTime (dist.ts) uses for percentiles. */
const LOAD_TIME_RETENTION_BUCKETS: { max: number; label: string }[] = [
  { max: 2000, label: '<2s' },
  { max: 4000, label: '2-4s' },
  { max: 8000, label: '4-8s' },
  { max: Infinity, label: '8s+' },
];
function loadTimeBucket(totalMs: number): string {
  return LOAD_TIME_RETENTION_BUCKETS.find((b) => totalMs < b.max)!.label;
}

interface FirstSessionRow {
  device: string;
  sid: string;
  firstTs: Date;
}

export class RetentionByService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number,
  ) {}

  /**
   * D1–D7 retention of the new-user cohort (each device's first-ever `session_start` falling in the
   * last `days`), grouped by `dimension`'s value on that device's first session.
   *
   * Per-device date-aligned offsets: a group can span several first-session dates, so "D+n" is each
   * device's OWN first date plus n days, not one shared calendar day. An offset a device hasn't
   * reached yet is excluded from that offset entirely (neither `d` nor `d_rate`'s denominator) — same
   * "insufficient data" convention traffic.ts's queryRetention uses per cohort-day, just evaluated
   * per-device here. See RetentionByRow's own doc for what that does to `d_rate`'s denominator.
   */
  async queryRetentionBy(days: number, dimension: RetentionByDimension, opts: { platform?: string } = {}): Promise<RetentionByRow[]> {
    const extraDays = Math.max(...RETENTION_OFFSETS);
    const sinceMs = dayStart(this.now()) - (days - 1 + extraDays) * 86400_000;
    const since = new Date(sinceMs);
    const displayStart = toDateStr(dayStart(this.now()) - (days - 1) * 86400_000);
    const platformMatch = opts.platform ? { platform: opts.platform } : {};

    // Active-devices-by-date, for the offset "did they come back" lookup — same shape as
    // traffic.ts's queryRetention, scoped to the same platform.
    const activeRows = await this.cols.events
      .aggregate<{ _id: string; devices: string[] }>([
        { $match: { ts: { $gte: since }, event: 'session_start', ...platformMatch } },
        { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, device: '$device_id' } } },
        { $group: { _id: '$_id.date', devices: { $push: '$_id.device' } } },
      ])
      .toArray();
    const byDate = new Map<string, Set<string>>();
    for (const r of activeRows) byDate.set(r._id, new Set(r.devices));

    // Each device's first-ever session (full retained window, not bounded to `since` — a device whose
    // true first session predates the display window must not be miscounted as new), with the
    // session_id needed to resolve `dimension`'s value from that exact session.
    const firstRows = await this.cols.events
      .aggregate<{ _id: string; sid: string; firstTs: Date }>([
        { $match: { event: 'session_start', ...platformMatch } },
        { $sort: { ts: 1 as const } },
        { $group: { _id: '$device_id', sid: { $first: '$session_id' }, firstTs: { $first: '$ts' } } },
      ])
      .toArray();

    const cohort: FirstSessionRow[] = firstRows
      .filter((r) => toDateStr(r.firstTs.getTime()) >= displayStart && r.sid)
      .map((r) => ({ device: r._id, sid: r.sid, firstTs: r.firstTs }));
    if (cohort.length === 0) return [];

    const valueByDevice = await this.resolveDimensionValues(dimension, cohort);

    const groups = new Map<string, { device: string; dateMs: number }[]>();
    for (const row of cohort) {
      const value = valueByDevice.get(row.device) ?? 'unknown';
      const dateMs = dayStart(row.firstTs.getTime());
      let g = groups.get(value);
      if (!g) { g = []; groups.set(value, g); }
      g.push({ device: row.device, dateMs });
    }

    const rows: RetentionByRow[] = [];
    for (const [value, devices] of groups) {
      const d: Partial<Record<RetentionOffset, number>> = {};
      const d_rate: Partial<Record<RetentionOffset, number>> = {};
      for (const offset of RETENTION_OFFSETS) {
        let eligible = 0;
        let returned = 0;
        for (const { device, dateMs } of devices) {
          const activeSet = byDate.get(toDateStr(dateMs + offset * 86400_000));
          if (activeSet === undefined) continue; // that day hasn't happened yet / no data at all
          eligible++;
          if (activeSet.has(device)) returned++;
        }
        if (eligible === 0) continue;
        d[offset] = returned;
        d_rate[offset] = returned / eligible;
      }
      rows.push({ value, cohort_size: devices.length, d, d_rate });
    }
    return rows.sort((a, b) => b.cohort_size - a.cohort_size);
  }

  /** Resolve each cohort device's `dimension` value from its first session. */
  private async resolveDimensionValues(dimension: RetentionByDimension, cohort: FirstSessionRow[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const CHUNK = 500;

    if (SESSION_DOC_DIMENSIONS.has(dimension)) {
      const sids = cohort.map((r) => r.sid);
      const deviceBySid = new Map(cohort.map((r) => [r.sid, r.device]));
      const field = dimension as 'browser' | 'device_type' | 'webview' | 'geo_country';
      for (let i = 0; i < sids.length; i += CHUNK) {
        const batch = sids.slice(i, i + CHUNK);
        const docs = await this.cols.sessions
          .find({ _id: { $in: batch } }, { projection: { [field]: 1 } })
          .toArray();
        for (const doc of docs) {
          const device = deviceBySid.get(doc._id);
          if (!device) continue;
          const raw = (doc as unknown as Record<string, unknown>)[field];
          result.set(device, typeof raw === 'string' && raw ? raw : 'unknown');
        }
      }
      // A device whose SessionDoc has already expired (90-day TTL) or never wrote one falls back below.
      for (const r of cohort) if (!result.has(r.device)) result.set(r.device, 'unknown');
      return result;
    }

    // Event-derived dimensions: scan the first session's own events for the relevant prop.
    const sids = cohort.map((r) => r.sid);
    const deviceBySid = new Map(cohort.map((r) => [r.sid, r.device]));
    const relevantEvents = ['login_ok', 'load_time', 'tutorial_complete', 'game_end', 'pvp_match_bot'];
    for (let i = 0; i < sids.length; i += CHUNK) {
      const batch = sids.slice(i, i + CHUNK);
      const sessions = await this.cols.events
        .aggregate<{ _id: string; docs: { event: string; props: Record<string, unknown> }[] }>([
          { $match: { session_id: { $in: batch }, event: { $in: relevantEvents } } },
          { $sort: { ts: 1 as const } },
          { $group: { _id: '$session_id', docs: { $push: { event: '$event', props: '$props' } } } },
        ])
        .toArray();
      for (const s of sessions) {
        const device = deviceBySid.get(s._id);
        if (!device) continue;
        result.set(device, resolveEventDimension(dimension, s.docs));
      }
    }
    // A first session with none of the relevant events (e.g. never logged in, never finished loading)
    // still belongs in a group — the dimension's own "nothing happened" value, not silently dropped.
    for (const r of cohort) if (!result.has(r.device)) result.set(r.device, resolveEventDimension(dimension, []));
    return result;
  }
}

function resolveEventDimension(dimension: RetentionByDimension, docs: { event: string; props: Record<string, unknown> }[]): string {
  switch (dimension) {
    case 'login_mode': {
      const ok = docs.find((d) => d.event === 'login_ok');
      const mode = ok?.props.mode;
      return typeof mode === 'string' && mode ? mode : 'device';
    }
    case 'load_time_bucket': {
      const lt = docs.find((d) => d.event === 'load_time');
      const totalMs = lt?.props.total_ms;
      return typeof totalMs === 'number' ? loadTimeBucket(totalMs) : 'unknown';
    }
    case 'tutorial_complete':
      return docs.some((d) => d.event === 'tutorial_complete') ? 'true' : 'false';
    case 'first_battle_result': {
      const end = docs.find((d) => d.event === 'game_end');
      const result = end?.props.result;
      return typeof result === 'string' && result ? result : 'none';
    }
    case 'matched_bot':
      return docs.some((d) => d.event === 'pvp_match_bot') ? 'true' : 'false';
    default:
      return 'unknown';
  }
}
