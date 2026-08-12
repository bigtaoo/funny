// analyticsvc query domain: raw traffic — per-event counts, DAU, login-hour histogram, rolling
// retention, and the first-session (brand-new device) breakdown.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): holds its own `cols`/`now`, no shared base, no cross-domain calls — assembled by
// composition in ../service.ts.

import { AnalyticsCollections } from '../db';
import { EventCountRow, DauRow, LoginHourRow, RETENTION_OFFSETS, RetentionOffset, RetentionRow, ONBOARDING_STEPS, ACTION_NOISE, EMPTY_STEP_KEYS, OnboardingStepRow, FirstSessionActionRow, FirstSessionResult, dayStart, toDateStr } from './defs';

export class TrafficService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number,
  ) {}

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
   * D1–D7 rolling retention: fraction of daily active devices in the last N days that are still
   * active on day +1 (next-day return) through day +7 (seventh-day return).
   * An extra 7-day data window is fetched so the later offsets can be computed for recent cohorts.
   */
  async queryRetention(days: number): Promise<RetentionRow[]> {
    const extraDays = Math.max(...RETENTION_OFFSETS);
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
        result.push({ date, cohort_size: 0, d: {}, d_rate: {} });
        continue;
      }
      const cohortDevices = [...cohort];
      const d: Partial<Record<RetentionOffset, number>> = {};
      const d_rate: Partial<Record<RetentionOffset, number>> = {};
      for (const offset of RETENTION_OFFSETS) {
        const laterSet = byDate.get(toDateStr(dateMs + offset * 86400_000));
        if (laterSet === undefined) continue;
        const returned = cohortDevices.filter((dev) => laterSet.has(dev)).length;
        d[offset] = returned;
        d_rate[offset] = returned / cohort.size;
      }
      result.push({ date, cohort_size: cohort.size, d, d_rate });
    }
    return result;
  }

  /**
   * First-session / onboarding analysis (A9-8): among devices whose FIRST-ever session_start falls in
   * the last N days (the new-user cohort), computes (a) an ordered onboarding drop-off funnel and
   * (b) a breakdown of which scenes/actions they hit — all scoped to that first session only.
   *
   * Caveat: "first-ever" is judged within the retained event window (events TTL = 90 days). A device
   * whose true first session predates retention but reappears in-window is not counted as new.
   */
  async queryFirstSession(days: number): Promise<FirstSessionResult> {
    const windowStart = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const windowEnd = new Date(dayStart(this.now()) + 86400_000); // end of today

    // Pass 1: each device's earliest session_start → keep only those whose first session is in-window.
    const cohortRows = await this.cols.events
      .aggregate<{ _id: string; sid: string; firstTs: Date }>([
        { $match: { event: 'session_start' } },
        { $sort: { ts: 1 } },
        { $group: { _id: '$device_id', sid: { $first: '$session_id' }, firstTs: { $first: '$ts' } } },
        { $match: { firstTs: { $gte: windowStart, $lt: windowEnd } } },
      ])
      .toArray();

    // First session is 1:1 with a device, keyed by its session_id (drop blank ids to avoid cross-device merges).
    const sids = cohortRows.map((r) => r.sid).filter((s) => s.length > 0);
    const cohortSize = sids.length;

    const emptyFunnel = (): OnboardingStepRow[] =>
      ONBOARDING_STEPS.map((s) => ({ step: s.key, count: 0 }));
    if (cohortSize === 0) {
      return { cohort_size: 0, window_days: days, funnel: emptyFunnel(), actions: [] };
    }

    // Pass 2: pull each first session's distinct (event, scene) pairs. Chunk the $in so a large cohort
    // never builds a pathological query; sids are unique so batches never overlap.
    const stepCounts = new Map<string, number>(ONBOARDING_STEPS.map((s) => [s.key, 0]));
    const sceneDevices = new Map<string, number>();
    const actionDevices = new Map<string, number>();
    const CHUNK = 500;
    for (let i = 0; i < sids.length; i += CHUNK) {
      const batch = sids.slice(i, i + CHUNK);
      const sessions = await this.cols.events
        .aggregate<{ _id: string; pairs: { event: string; scene?: string }[] }>([
          { $match: { session_id: { $in: batch } } },
          { $group: { _id: '$session_id', pairs: { $addToSet: { event: '$event', scene: '$props.scene' } } } },
        ])
        .toArray();

      for (const s of sessions) {
        const events = new Set<string>();
        const scenes = new Set<string>();
        for (const p of s.pairs) {
          events.add(p.event);
          if (p.event === 'screen_view' && typeof p.scene === 'string' && p.scene) scenes.add(p.scene);
        }
        for (const step of ONBOARDING_STEPS) {
          if (step.reached(events, scenes, EMPTY_STEP_KEYS)) stepCounts.set(step.key, stepCounts.get(step.key)! + 1);
        }
        for (const scene of scenes) sceneDevices.set(scene, (sceneDevices.get(scene) ?? 0) + 1);
        for (const ev of events) {
          if (ACTION_NOISE.has(ev)) continue;
          actionDevices.set(ev, (actionDevices.get(ev) ?? 0) + 1);
        }
      }
    }

    // Build ordered funnel with step-over-step conversion.
    const funnel: OnboardingStepRow[] = [];
    let prev: number | undefined;
    for (const step of ONBOARDING_STEPS) {
      const count = stepCounts.get(step.key)!;
      funnel.push({ step: step.key, count, conversion_rate: prev !== undefined && prev > 0 ? count / prev : undefined });
      prev = count;
    }

    // Merge scene + action breakdowns, sorted by reach descending.
    const actions: FirstSessionActionRow[] = [
      ...[...sceneDevices].map(([key, devices]) => ({ key, kind: 'scene' as const, devices, rate: devices / cohortSize })),
      ...[...actionDevices].map(([key, devices]) => ({ key, kind: 'action' as const, devices, rate: devices / cohortSize })),
    ].sort((a, b) => b.devices - a.devices);

    return { cohort_size: cohortSize, window_days: days, funnel, actions };
  }
}
