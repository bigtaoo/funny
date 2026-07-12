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
    // Onboarding milestones — fully sampled so the first-session funnel (A9-8) is accurate and
    // comparable to session_start (100%); tutorial_start/complete were previously falling back to
    // defaultSample (0.1), which would have distorted the tutorial completion rate.
    tutorial_start:    { sample: 1.0 },
    tutorial_complete: { sample: 1.0 },
    tutorial_skip:  { sample: 1.0 },
    // Fine-grained tutorial-step / nav funnels (A9-9): must be 100% sampled, same reasoning as
    // tutorial_start/complete above — sampling them would distort the step-by-step drop-off.
    tutorial_step:  { sample: 1.0 },
    nav_checkpoint: { sample: 1.0 },
    login_gate_hit: { sample: 1.0 },
    churn_signal:   { sample: 1.0 },
    // Button-level clicks (A9-8). Fully sampled for now so first-day "which button" analysis is exact;
    // dial down here if lobby-click volume becomes a concern.
    ui_click:       { sample: 1.0 },
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
  /** Raw device fields (A9-9); web only, absent for wechat/crazygames. Browser/device_type are derived server-side from `ua`, never trusted from the client. */
  ua?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
}

/** Server-resolved geo, attached by httpApi.ts from the request IP (geoip-lite). Never persists the raw IP. */
export interface ResolvedGeo {
  country?: string;
  region?: string;
  city?: string;
}

// ─── Lightweight UA parsing (A9-9) ────────────────────────────────────────────
// Intentionally hand-rolled (no ua-parser-js dependency) — analyticsvc is a plain node:http service with
// no framework, and we only need coarse browser-name/device-type buckets for the ops dashboard, not exact
// version parsing.
export function parseUserAgent(ua: string | undefined): { browser: string; device_type: 'mobile' | 'tablet' | 'desktop' } {
  const s = ua ?? '';
  let browser = 'unknown';
  if (/MicroMessenger/i.test(s)) browser = 'wechat';
  else if (/QQBrowser/i.test(s)) browser = 'qqbrowser';
  else if (/Edg\//i.test(s)) browser = 'edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'opera';
  else if (/Firefox\//i.test(s)) browser = 'firefox';
  else if (/CriOS|Chrome\//i.test(s)) browser = 'chrome';
  else if (/Safari\//i.test(s)) browser = 'safari';

  let device_type: 'mobile' | 'tablet' | 'desktop' = 'desktop';
  if (/iPad|Tablet(?!.*Mobile)/i.test(s)) device_type = 'tablet';
  else if (/Mobi|Android|iPhone|iPod/i.test(s)) device_type = 'mobile';

  return { browser, device_type };
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
// Day offsets tracked for rolling retention (D1 = next-day return … D7 = seventh-day return).
export const RETENTION_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;
export type RetentionOffset = (typeof RETENTION_OFFSETS)[number];

export interface RetentionRow {
  date: string;
  cohort_size: number;
  /** Returning device count per day offset, keyed by offset (e.g. d[1], d[7]); undefined = not enough data yet. */
  d: Partial<Record<RetentionOffset, number>>;
  /** Returning device fraction per day offset (d[n] / cohort_size). */
  d_rate: Partial<Record<RetentionOffset, number>>;
}

// ─── First-session / onboarding analysis (A9-8) ───────────────────────────────
// Everything here is scoped to a device's FIRST session (its earliest session_start),
// so it answers "what do brand-new players do the first time they enter the game" —
// unlike the all-users funnel ETL / DAU / retention above.

/**
 * One ordered step of a cohort-based funnel. `reached` tests a session's accumulated signals:
 * `events` = distinct event names seen, `scenes` = distinct `screen_view` scene names, `stepKeys` =
 * distinct `tutorial_step` step keys (see TUTORIAL_STEPS). Steps that don't need a given set simply
 * ignore that parameter (TS structural typing allows fewer-arg callbacks).
 */
export interface OnboardingStep {
  key: string;
  reached: (events: Set<string>, scenes: Set<string>, stepKeys: Set<string>) => boolean;
}

/**
 * Ordered onboarding funnel: open → tutorial start → tutorial finished → first real battle → first clear.
 * Drop-off between adjacent steps localises where day-1 players quit; tutorial_complete ÷ tutorial_start
 * is the tutorial completion rate.
 *
 * Every step here is derived from a 100%-sampled event (see DEFAULT_CONFIG) so the counts are directly
 * comparable. Deliberately excludes screen_view-derived milestones (intro / lobby arrival) — screen_view
 * is sampled at 5%, so folding it in would show sampling-driven cliffs rather than real drop-off. Those
 * scenes still appear (sample-affected) in the action breakdown.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { key: 'session_start', reached: () => true }, // baseline = whole cohort (all had a first session_start)
  { key: 'tutorial_start', reached: (e) => e.has('tutorial_start') },
  { key: 'tutorial_complete', reached: (e) => e.has('tutorial_complete') },
  { key: 'first_battle', reached: (e) => e.has('game_start') }, // first non-tutorial battle
  { key: 'first_clear', reached: (e) => e.has('level_complete') }, // first real level clear
];

// Lifecycle/plumbing events excluded from the "which action did they take" breakdown (screen_view is
// surfaced separately as scene rows). Everything else counts as a semantic action.
const ACTION_NOISE = new Set(['session_start', 'session_end', 'screen_view', 'churn_signal']);

// Shared placeholder for callers that don't track tutorial_step keys (e.g. ONBOARDING_STEPS reached()).
const EMPTY_STEP_KEYS: Set<string> = new Set();

// ─── Tutorial step-level funnel (A9-9) ────────────────────────────────────────
// Fine-grained breakdown of *where inside the tutorial* a new player quits — as opposed to the coarse
// tutorial_start/tutorial_complete pair in ONBOARDING_STEPS above. Driven by a `tutorial_step` event
// (100% sampled, see DEFAULT_CONFIG) whose `props.step_key` matches one of the keys below in order;
// emitted by client/src/render/TutorialDirector.ts via GameNav.goTutorial().
export const TUTORIAL_ORDERED_KEYS = [
  'tutorial_start',
  'orientation_1', 'orientation_2', 'orientation_3', 'orientation_4', 'orientation_5', 'orientation_6', 'orientation_7',
  'beat_unit', 'beat_building', 'beat_spell',
  'freeplay',
  'tutorial_complete',
] as const;

export const TUTORIAL_STEPS: OnboardingStep[] = TUTORIAL_ORDERED_KEYS.map((key) => {
  if (key === 'tutorial_start') return { key, reached: (e: Set<string>) => e.has('tutorial_start') };
  if (key === 'tutorial_complete') return { key, reached: (e: Set<string>) => e.has('tutorial_complete') };
  return { key, reached: (_e: Set<string>, _s: Set<string>, stepKeys: Set<string>) => stepKeys.has(key) };
});

// ─── Scene/page-level funnel (A9-9) ───────────────────────────────────────────
// The core new-user navigation path: login → intro/tutorial gate → lobby → pick a level → prep → battle.
// Backed by a 100%-sampled `nav_checkpoint` event (screen_view itself stays at 5% sampling and is not
// reliable enough for a per-scene funnel) fired by client/src/analytics/index.ts for exactly this scene
// allowlist. Extend NAV_CHECKPOINT_SCENES client-side to add more gates.
export const SCENE_FUNNEL_SCENES = ['LoginScene', 'IntroScene', 'LobbyScene', 'CampaignMapScene', 'LevelPrepScene', 'GameScene'] as const;

export const SCENE_FUNNEL_STEPS: OnboardingStep[] = SCENE_FUNNEL_SCENES.map((scene) => ({
  key: scene,
  reached: (_e: Set<string>, scenes: Set<string>) => scenes.has(scene),
}));

export interface StepFunnelResult {
  cohort_size: number;
  window_days: number;
  funnel: OnboardingStepRow[];
}

// ─── Per-level funnel (A9-9) ──────────────────────────────────────────────────
// level_attempt/level_complete/level_abandon already carry props.level_id (client/src/app/nav/game.ts),
// so this is a direct aggregation — no new client instrumentation needed. Each step is counted
// independently (distinct devices per event per level), not as a same-session cohort chain: attempt and
// complete for a given level_id are already causally linked by the level itself.
export interface LevelFunnelRow {
  level_id: string;
  attempts: number;
  completes: number;
  abandons: number;
  completion_rate?: number;
}

// ─── Device / geo distributions (A9-9) ────────────────────────────────────────
export interface BrowserRow { browser: string; devices: number }
export interface DeviceTypeRow { device_type: string; devices: number }
export interface GeoRow { country: string; devices: number }

export interface OnboardingStepRow {
  step: string;
  count: number;
  /** Fraction of the previous step that reached this step (undefined for the first step). */
  conversion_rate?: number;
}
export interface FirstSessionActionRow {
  /** Scene name (kind='scene') or event name (kind='action'). */
  key: string;
  kind: 'scene' | 'action';
  /** Distinct new-user devices that hit this scene/action in their first session. */
  devices: number;
  /** devices / cohort_size. */
  rate: number;
}
export interface FirstSessionResult {
  /** New-user devices whose first-ever session_start falls in the window. */
  cohort_size: number;
  window_days: number;
  funnel: OnboardingStepRow[];
  actions: FirstSessionActionRow[];
}

export interface QueryResult {
  event_counts?: EventCountRow[];
  dau?: DauRow[];
  funnel?: FunnelDailyDoc[];
  region_dist?: RegionRow[];
  os_dist?: OsRow[];
  login_hour?: LoginHourRow[];
  retention?: RetentionRow[];
  first_session?: FirstSessionResult;
  level_funnel?: LevelFunnelRow[];
  tutorial_funnel?: StepFunnelResult;
  scene_funnel?: StepFunnelResult;
  browser_dist?: BrowserRow[];
  device_type_dist?: DeviceTypeRow[];
  geo_dist?: GeoRow[];
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

  async ingestEvents(batch: EventBatch, userId: string | undefined, geo?: ResolvedGeo): Promise<void> {
    if (!batch.events || batch.events.length === 0) return;

    const { browser, device_type } = parseUserAgent(batch.ua);
    const deviceFields = {
      ...(batch.ua ? { ua: batch.ua } : {}),
      ...(typeof batch.screen_w === 'number' ? { screen_w: batch.screen_w } : {}),
      ...(typeof batch.screen_h === 'number' ? { screen_h: batch.screen_h } : {}),
      ...(typeof batch.dpr === 'number' ? { dpr: batch.dpr } : {}),
      ...(batch.ua ? { browser, device_type } : {}),
      ...(geo?.country ? { geo_country: geo.country } : {}),
      ...(geo?.region ? { geo_region: geo.region } : {}),
      ...(geo?.city ? { geo_city: geo.city } : {}),
    };

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
      ...deviceFields,
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
            ...deviceFields,
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
