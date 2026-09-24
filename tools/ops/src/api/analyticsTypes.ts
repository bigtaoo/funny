// Return shape of Api.analyticsEvents (index.ts hit the 500-line gate 2026-09-24; this hand-typed
// REST payload — one field per `type` the admin analytics endpoint accepts — was the single largest
// block in that file and carries no logic of its own, so it moved out on its own, same treatment as
// tools/ops/src/pages/analyticsCards.ts's split the same day).
export interface AnalyticsEventsResult {
  available: boolean;
  event_counts?: { date: string; event: string; count: number }[];
  dau?: { date: string; dau: number }[];
  funnel?: { date: string; platform: string; funnel_step: string; count: number; conversion_rate?: number }[];
  region_dist?: { locale: string; devices: number }[];
  os_dist?: { os: string; devices: number }[];
  login_hour?: { hour: number; count: number }[];
  retention?: {
    date: string;
    cohort_size: number;
    d: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
    d_rate: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
  }[];
  first_session?: {
    cohort_size: number;
    window_days: number;
    funnel: { step: string; count: number; conversion_rate?: number }[];
    actions: { key: string; kind: 'scene' | 'action'; devices: number; rate: number }[];
  };
  level_funnel?: { level_id: string; attempts: number; completes: number; abandons: number; completion_rate?: number }[];
  tutorial_funnel?: {
    cohort_size: number;
    window_days: number;
    funnel: { step: string; count: number; conversion_rate?: number }[];
  };
  scene_funnel?: {
    cohort_size: number;
    window_days: number;
    funnel: { step: string; count: number; conversion_rate?: number }[];
  };
  feature_guide_funnel?: { feature: string; shown: number; closed: number; replays: number; close_rate?: number }[];
  browser_dist?: { browser: string; devices: number }[];
  device_type_dist?: { device_type: string; devices: number }[];
  webview_dist?: { webview: string; devices: number }[];
  geo_dist?: { country: string; devices: number }[];
  badge_dist?: { mode: string; result: string; badge: string; count: number }[];
  boot_funnel?: { date: string; platform: string; boots: number; sessions: number; declined: number; consents: number; reach_rate?: number }[];
  load_time?: {
    platform: string;
    samples: number;
    p50_ms: number;
    p75_ms: number;
    p90_ms: number;
    p95_ms: number;
    avg: Record<string, number>;
    buckets: { lt_ms: number; count: number }[];
    abandoned: number;
  }[];
  retention_by?: {
    value: string;
    cohort_size: number;
    d: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
    d_rate: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
  }[];
  session_duration_dist?: {
    platform: string;
    samples: number;
    p50_sec: number;
    p75_sec: number;
    p90_sec: number;
    p95_sec: number;
    buckets: { lt_sec: number; count: number }[];
  }[];
  churn_scene_dist?: { scene: string; count: number }[];
}
