// analyticsvc query domain: funnels. runFunnelEtl materialises the daily funnel doc; the query*
// methods read the onboarding / tutorial / scene / level / feature-guide step chains.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): holds its own `cols`/`now`, no shared base, no cross-domain calls — assembled by
// composition in ../service.ts.
import type { AnalyticsCollections, FunnelDailyDoc } from '../db';
import { OnboardingStep, TUTORIAL_STEPS, SCENE_FUNNEL_STEPS, StepFunnelResult, LevelFunnelRow, FeatureGuideFunnelRow, OnboardingStepRow, FUNNEL_STEPS, dayStart, toDateStr } from './defs';

export class FunnelService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number,
  ) {}

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

  /**
   * Shared cohort-funnel engine for step-based funnels (tutorial, scene) that don't need the
   * scene/action breakdown queryFirstSession also computes. Pulls each session's distinct
   * (event, scene, tutorial step_key) signals in chunks, then evaluates `steps` in order.
   */
  private async computeStepFunnel(sids: string[], steps: OnboardingStep[]): Promise<OnboardingStepRow[]> {
    const stepCounts = new Map<string, number>(steps.map((s) => [s.key, 0]));
    const CHUNK = 500;
    for (let i = 0; i < sids.length; i += CHUNK) {
      const batch = sids.slice(i, i + CHUNK);
      const sessions = await this.cols.events
        .aggregate<{ _id: string; pairs: { event: string; scene?: string; step_key?: string }[] }>([
          { $match: { session_id: { $in: batch } } },
          { $group: { _id: '$session_id', pairs: { $addToSet: { event: '$event', scene: '$props.scene', step_key: '$props.step_key' } } } },
        ])
        .toArray();

      for (const s of sessions) {
        const events = new Set<string>();
        const scenes = new Set<string>();
        const stepKeys = new Set<string>();
        for (const p of s.pairs) {
          events.add(p.event);
          if (p.event === 'screen_view' && typeof p.scene === 'string' && p.scene) scenes.add(p.scene);
          if (p.event === 'nav_checkpoint' && typeof p.scene === 'string' && p.scene) scenes.add(p.scene);
          if (p.event === 'tutorial_step' && typeof p.step_key === 'string' && p.step_key) stepKeys.add(p.step_key);
        }
        for (const step of steps) {
          if (step.reached(events, scenes, stepKeys)) stepCounts.set(step.key, stepCounts.get(step.key)! + 1);
        }
      }
    }

    const funnel: OnboardingStepRow[] = [];
    let prev: number | undefined;
    for (const step of steps) {
      const count = stepCounts.get(step.key)!;
      funnel.push({ step: step.key, count, conversion_rate: prev !== undefined && prev > 0 ? count / prev : undefined });
      prev = count;
    }
    return funnel;
  }

  /** Tutorial step-level funnel (A9-9): cohort = sessions with a tutorial_start in the window. */
  async queryTutorialFunnel(days: number): Promise<StepFunnelResult> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const rows = await this.cols.events
      .aggregate<{ _id: string }>([
        { $match: { event: 'tutorial_start', ts: { $gte: since } } },
        { $group: { _id: '$session_id' } },
      ])
      .toArray();
    const sids = rows.map((r) => r._id).filter((s) => s && s.length > 0);
    if (sids.length === 0) {
      return { cohort_size: 0, window_days: days, funnel: TUTORIAL_STEPS.map((s) => ({ step: s.key, count: 0 })) };
    }
    const funnel = await this.computeStepFunnel(sids, TUTORIAL_STEPS);
    return { cohort_size: sids.length, window_days: days, funnel };
  }

  /** Scene/page-level funnel (A9-9): cohort = all sessions started in the window. */
  async querySceneFunnel(days: number): Promise<StepFunnelResult> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const rows = await this.cols.events
      .aggregate<{ _id: string }>([
        { $match: { event: 'session_start', ts: { $gte: since } } },
        { $group: { _id: '$session_id' } },
      ])
      .toArray();
    const sids = rows.map((r) => r._id).filter((s) => s && s.length > 0);
    if (sids.length === 0) {
      return { cohort_size: 0, window_days: days, funnel: SCENE_FUNNEL_STEPS.map((s) => ({ step: s.key, count: 0 })) };
    }
    const funnel = await this.computeStepFunnel(sids, SCENE_FUNNEL_STEPS);
    return { cohort_size: sids.length, window_days: days, funnel };
  }

  /**
   * Per-level funnel (A9-9): distinct-device attempts/completes/abandons per level_id, sorted by
   * completion rate ascending so the levels players quit on most sit at the top.
   */
  async queryLevelFunnel(days: number, platform?: string): Promise<LevelFunnelRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const match: Record<string, unknown> = {
      ts: { $gte: since },
      event: { $in: ['level_attempt', 'level_complete', 'level_abandon'] },
      'props.level_id': { $exists: true, $ne: null },
    };
    if (platform) match['platform'] = platform;
    const pipeline = [
      { $match: match },
      { $group: { _id: { level: '$props.level_id', event: '$event', device: '$device_id' } } },
      { $group: { _id: { level: '$_id.level', event: '$_id.event' }, count: { $sum: 1 } } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: { level: unknown; event: string }; count: number }>(pipeline)
      .toArray();

    const byLevel = new Map<string, { attempts: number; completes: number; abandons: number }>();
    for (const r of rows) {
      const level = String(r._id.level);
      if (!byLevel.has(level)) byLevel.set(level, { attempts: 0, completes: 0, abandons: 0 });
      const entry = byLevel.get(level)!;
      if (r._id.event === 'level_attempt') entry.attempts = r.count;
      else if (r._id.event === 'level_complete') entry.completes = r.count;
      else if (r._id.event === 'level_abandon') entry.abandons = r.count;
    }
    return [...byLevel.entries()]
      .map(([level_id, v]) => ({
        level_id,
        ...v,
        completion_rate: v.attempts > 0 ? v.completes / v.attempts : undefined,
      }))
      .sort((a, b) => (a.completion_rate ?? 1) - (b.completion_rate ?? 1));
  }

  /**
   * Per-feature guide funnel (design-doc-audit-2026-07): distinct-device shown/closed/replay counts per
   * feature (props.feature, e.g. match/shop/social/cards/daily/world), sorted by close rate ascending so
   * the guides players dismiss the least (lowest close/shown) surface first. Same shape as
   * queryLevelFunnel above.
   */
  async queryFeatureGuideFunnel(days: number, platform?: string): Promise<FeatureGuideFunnelRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const match: Record<string, unknown> = {
      ts: { $gte: since },
      event: { $in: ['feature_guide_shown', 'feature_guide_closed', 'feature_guide_replay'] },
      'props.feature': { $exists: true, $ne: null },
    };
    if (platform) match['platform'] = platform;
    const pipeline = [
      { $match: match },
      { $group: { _id: { feature: '$props.feature', event: '$event', device: '$device_id' } } },
      { $group: { _id: { feature: '$_id.feature', event: '$_id.event' }, count: { $sum: 1 } } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: { feature: unknown; event: string }; count: number }>(pipeline)
      .toArray();

    const byFeature = new Map<string, { shown: number; closed: number; replays: number }>();
    for (const r of rows) {
      const feature = String(r._id.feature);
      if (!byFeature.has(feature)) byFeature.set(feature, { shown: 0, closed: 0, replays: 0 });
      const entry = byFeature.get(feature)!;
      if (r._id.event === 'feature_guide_shown') entry.shown = r.count;
      else if (r._id.event === 'feature_guide_closed') entry.closed = r.count;
      else if (r._id.event === 'feature_guide_replay') entry.replays = r.count;
    }
    return [...byFeature.entries()]
      .map(([feature, v]) => ({
        feature,
        ...v,
        close_rate: v.shown > 0 ? v.closed / v.shown : undefined,
      }))
      .sort((a, b) => (a.close_rate ?? 1) - (b.close_rate ?? 1));
  }
}
