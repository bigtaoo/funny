// analyticsvc shared declarations: the collection/sampling config, the event-ingestion and
// query-result shapes, the hand-rolled UA parser, and the ordered step definitions behind every
// funnel (onboarding / tutorial / scene / level / feature-guide). Pure data and types — no I/O,
// no service state — imported by ../service.ts's mixins and re-exported from it for callers.
import type { FunnelDailyDoc } from '../db';

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
    // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8). Low-frequency (one per match),
    // high-value for balance monitoring — 100% sampled so the badge_dist dashboard isn't skewed.
    match_badges:   { sample: 1.0 },
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
    // Intro-story funnel node (ONBOARDING_DESIGN §7, design-doc-audit-2026-07): the only step in the
    // funnel enumeration that previously had zero data — IntroScene wrote the local nw_seen_intro flag
    // but never called analytics.track. 100% sampled like tutorial_start/complete, same rationale.
    intro_complete: { sample: 1.0 },
    intro_skip:     { sample: 1.0 },
    // First-time feature-guide funnel (ONBOARDING_DESIGN §4.1/§7): showFeatureGuide/withGuide
    // (client/src/app/nav/lobby.ts) previously had zero analytics.track calls. feature_guide_replay is
    // reserved for the per-page "?" re-open button, which is not wired yet (ONBOARDING_DESIGN §8/§10) —
    // config is added ahead of time so it isn't missed once that UI lands.
    feature_guide_shown:  { sample: 1.0 },
    feature_guide_closed: { sample: 1.0 },
    feature_guide_replay: { sample: 1.0 },
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

/**
 * Request IP + server-resolved geo, attached by httpApi.ts. The raw IP is stored (account-protection:
 * shared-IP abuse / multi-account detection, ban evasion) alongside the geoip-lite-derived country/
 * region/city used for the ops distribution chart.
 */
export interface ResolvedGeo {
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
}

// ─── Lightweight UA parsing (A9-9) ────────────────────────────────────────────
// Intentionally hand-rolled (no ua-parser-js dependency) — analyticsvc is a plain node:http service with
// no framework, and we only need coarse browser-name/device-type buckets for the ops dashboard, not exact
// version parsing.
export function parseUserAgent(ua: string | undefined): {
  browser: string;
  device_type: 'mobile' | 'tablet' | 'desktop';
  webview?: string;
} {
  const s = ua ?? '';
  let browser = 'unknown';
  if (/MicroMessenger/i.test(s)) browser = 'wechat';
  else if (/QQBrowser/i.test(s)) browser = 'qqbrowser';
  else if (/Edg\//i.test(s)) browser = 'edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'opera';
  else if (/Firefox\//i.test(s)) browser = 'firefox';
  else if (/CriOS|Chrome\//i.test(s)) browser = 'chrome';
  else if (/Safari\//i.test(s)) browser = 'safari';

  // Kept as its own axis rather than folded into `browser`, for two reasons: `browser` values already
  // feed the ops distribution chart and renaming them would silently rewrite history, and the answer
  // is genuinely not a browser name — a GSA WebView really *is* WebKit, so `browser=safari` is
  // incomplete rather than wrong. What it hides is the host app, and the host app is what matters:
  // in-app WebViews run under far tighter memory ceilings than the standalone browser and get killed
  // by the OS instead of surfacing an error. Before this field, every one of them was indistinguishable
  // from ordinary Safari/Chrome traffic — which is how a crash-loop report from a Google-app WebView
  // (2026-08-22, see FEATURE_FLAGS_DESIGN §8) could not be attributed to its environment class at all.
  const webview = detectWebView(s);

  // Mirrors client/src/net/anomaly/deviceContext.ts's classify(). The two are deliberately kept in
  // step: `device_type` here and `device` on the anomaly channel answer the same question about the
  // same session, and a disagreement between them would be worse than either being slightly coarse.
  // Both traps below fail in the direction that HIDES a non-phone, which is the direction that misleads.
  let device_type: 'mobile' | 'tablet' | 'desktop' = 'desktop';
  if (/iPad/i.test(s)) device_type = 'tablet';
  // Android tablets omit the `Mobile` token that Android phones carry. The previous rule tested
  // `Mobi|Android` together, so every Android tablet was counted as a phone.
  else if (/Android/i.test(s)) device_type = /Mobi/i.test(s) ? 'mobile' : 'tablet';
  else if (/Tablet|PlayBook|Silk/i.test(s)) device_type = 'tablet';
  else if (/Mobi|iPhone|iPod/i.test(s)) device_type = 'mobile';

  return webview ? { browser, device_type, webview } : { browser, device_type };
}

/**
 * Name the host app when the page is running inside an embedded WebView rather than a real browser.
 * Undefined for ordinary browser traffic.
 *
 * Order matters: several of these apps stack their token onto an otherwise normal Safari/Chrome UA,
 * and a few carry more than one (Instagram's in-app browser reports both `Instagram` and `FBAV`),
 * so the more specific product is tested first.
 */
function detectWebView(s: string): string | undefined {
  if (/MicroMessenger/i.test(s)) return 'wechat';
  if (/Instagram/i.test(s)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(s)) return 'facebook';
  if (/\bGSA\//i.test(s)) return 'gsa';           // the Google app on iOS
  if (/\bLine\//i.test(s)) return 'line';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(s)) return 'tiktok';
  if (/Snapchat/i.test(s)) return 'snapchat';
  if (/\bTwitter\b/i.test(s)) return 'twitter';
  // Generic Android System WebView: Chrome's UA with a `; wv` marker in the platform section.
  if (/;\s*wv\)/i.test(s)) return 'android-wv';
  return undefined;
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
/** One (mode, result, badge) cell of the post-match badge/title distribution (ANALYTICS_DESIGN §5.8). */
export interface BadgeDistRow { mode: string; result: string; badge: string; count: number }
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
 * Ordered onboarding funnel: open → intro seen → tutorial start → tutorial finished → first real battle →
 * first clear. Drop-off between adjacent steps localises where day-1 players quit; tutorial_complete ÷
 * tutorial_start is the tutorial completion rate.
 *
 * Every step here is derived from a 100%-sampled event (see DEFAULT_CONFIG) so the counts are directly
 * comparable. Deliberately excludes screen_view-derived milestones (e.g. lobby arrival) — screen_view is
 * sampled at 5%, so folding it in would show sampling-driven cliffs rather than real drop-off. `intro_seen`
 * is the exception: it reads dedicated 100%-sampled `intro_complete`/`intro_skip` events (not screen_view),
 * added design-doc-audit-2026-07 — this funnel previously had no data for the intro step at all. Scenes
 * still appear (sample-affected) in the action breakdown below.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { key: 'session_start', reached: () => true }, // baseline = whole cohort (all had a first session_start)
  // intro_complete/intro_skip (design-doc-audit-2026-07) are 100%-sampled like the rest of this funnel —
  // unlike screen_view (5%), they belong here instead of being excluded per the comment above.
  { key: 'intro_seen', reached: (e) => e.has('intro_complete') || e.has('intro_skip') },
  { key: 'tutorial_start', reached: (e) => e.has('tutorial_start') },
  { key: 'tutorial_complete', reached: (e) => e.has('tutorial_complete') },
  { key: 'first_battle', reached: (e) => e.has('game_start') }, // first non-tutorial battle
  { key: 'first_clear', reached: (e) => e.has('level_complete') }, // first real level clear
];

// Lifecycle/plumbing events excluded from the "which action did they take" breakdown (screen_view is
// surfaced separately as scene rows). Everything else counts as a semantic action.
export const ACTION_NOISE = new Set(['session_start', 'session_end', 'screen_view', 'churn_signal']);

// Shared placeholder for callers that don't track tutorial_step keys (e.g. ONBOARDING_STEPS reached()).
export const EMPTY_STEP_KEYS: Set<string> = new Set();

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

// ─── First-time feature-guide funnel (design-doc-audit-2026-07) ──────────────
// feature_guide_shown/feature_guide_closed carry props.feature (client/src/app/nav/lobby.ts withGuide);
// same distinct-device-per-event-per-key aggregation as queryLevelFunnel above. feature_guide_replay is
// included so the row exists once the per-page "?" re-open button (ONBOARDING_DESIGN §8/§10, not wired
// yet) starts emitting it — until then replays stays 0 for every feature.
export interface FeatureGuideFunnelRow {
  feature: string;
  shown: number;
  closed: number;
  replays: number;
  close_rate?: number;
}

// ─── Device / geo distributions (A9-9) ────────────────────────────────────────
export interface BrowserRow { browser: string; devices: number }
export interface DeviceTypeRow { device_type: string; devices: number }
/** Host app for embedded-WebView sessions;  is ordinary browser traffic. */
export interface WebViewRow { webview: string; devices: number }
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
  feature_guide_funnel?: FeatureGuideFunnelRow[];
  browser_dist?: BrowserRow[];
  device_type_dist?: DeviceTypeRow[];
  webview_dist?: WebViewRow[];
  geo_dist?: GeoRow[];
}

// Funnel step definitions (order defines the conversion chain; the ETL uses the same list when writing funnels_daily).
export const FUNNEL_STEPS = ['session_start', 'game_start', 'level_attempt', 'level_complete'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// Start-of-day timestamp (UTC).
export function dayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function toDateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// Bounds for client-declared event timestamps (2026-07-29 audit fix): `events.ts`/`sessions.started_at`
// are the fields the 90-day TTL indexes key off (server.md's Mongo/Redis audit, T8), and also the fields
// DAU/retention/funnel aggregation bucket by day (dayStart/toDateStr above) — an unclamped future value
// would let a record evade TTL expiry forever, and an unclamped past/negative value would land in the
// wrong day-bucket and skew those aggregates. The window is generous (absorbs real clock skew + batched/
// retried sends), not tight validation — out-of-range or non-finite falls back to server time.
export const MAX_EVENT_TS_PAST_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENT_TS_FUTURE_MS = 5 * 60 * 1000;
export function clampEventTs(raw: unknown, now: number): Date {
  if (
    typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw >= now - MAX_EVENT_TS_PAST_MS &&
    raw <= now + MAX_EVENT_TS_FUTURE_MS
  ) {
    return new Date(raw);
  }
  return new Date(now);
}

