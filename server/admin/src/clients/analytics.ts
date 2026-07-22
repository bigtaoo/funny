import { internalHeaders } from '@nw/shared';
import { log } from './shared';

// ── analyticsvc query (/internal/query, A9-6) ────────────────
export interface AnalyticsEventCountRow { date: string; event: string; count: number }
export interface AnalyticsDauRow { date: string; dau: number }
export interface AnalyticsFunnelRow { date: string; platform: string; funnel_step: string; count: number; conversion_rate?: number }

export interface AnalyticsRegionRow { locale: string; devices: number }
export interface AnalyticsOsRow { os: string; devices: number }
export interface AnalyticsLoginHourRow { hour: number; count: number }
export type AnalyticsRetentionOffset = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface AnalyticsRetentionRow {
  date: string;
  cohort_size: number;
  d: Partial<Record<AnalyticsRetentionOffset, number>>;
  d_rate: Partial<Record<AnalyticsRetentionOffset, number>>;
}

// First-session / onboarding analysis (A9-8).
export interface AnalyticsOnboardingStepRow { step: string; count: number; conversion_rate?: number }
export interface AnalyticsFirstSessionActionRow { key: string; kind: 'scene' | 'action'; devices: number; rate: number }
export interface AnalyticsFirstSessionResult {
  cohort_size: number;
  window_days: number;
  funnel: AnalyticsOnboardingStepRow[];
  actions: AnalyticsFirstSessionActionRow[];
}

// Fine-grained level/tutorial/scene funnels + device/geo distributions (A9-9).
export interface AnalyticsLevelFunnelRow {
  level_id: string;
  attempts: number;
  completes: number;
  abandons: number;
  completion_rate?: number;
}
export interface AnalyticsStepFunnelResult {
  cohort_size: number;
  window_days: number;
  funnel: AnalyticsOnboardingStepRow[];
}
export interface AnalyticsBrowserRow { browser: string; devices: number }
export interface AnalyticsDeviceTypeRow { device_type: string; devices: number }
export interface AnalyticsGeoRow { country: string; devices: number }
// Post-match badge/title distribution (ANALYTICS_DESIGN §5.8): count of matches per (mode, result, hero badge).
export interface AnalyticsBadgeDistRow { mode: string; result: string; badge: string; count: number }

export interface AnalyticsQueryResult {
  event_counts?: AnalyticsEventCountRow[];
  dau?: AnalyticsDauRow[];
  funnel?: AnalyticsFunnelRow[];
  region_dist?: AnalyticsRegionRow[];
  os_dist?: AnalyticsOsRow[];
  login_hour?: AnalyticsLoginHourRow[];
  retention?: AnalyticsRetentionRow[];
  first_session?: AnalyticsFirstSessionResult;
  level_funnel?: AnalyticsLevelFunnelRow[];
  tutorial_funnel?: AnalyticsStepFunnelResult;
  scene_funnel?: AnalyticsStepFunnelResult;
  browser_dist?: AnalyticsBrowserRow[];
  device_type_dist?: AnalyticsDeviceTypeRow[];
  geo_dist?: AnalyticsGeoRow[];
  badge_dist?: AnalyticsBadgeDistRow[];
}

export interface AnalyticsClient {
  readonly available: boolean;
  query(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult>;
}

export class HttpAnalyticsClient implements AnalyticsClient {
  constructor(
    private readonly analyticsUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.analyticsUrl !== null; }

  async query(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult> {
    if (!this.analyticsUrl) return {};
    try {
      const qs = new URLSearchParams({ type, days: String(days) });
      if (platform) qs.set('platform', platform);
      const res = await fetch(`${this.analyticsUrl}/internal/query?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('analytics query non-2xx', { type, status: res.status });
        return {};
      }
      type Payload = {
        type: string;
        counts?: AnalyticsEventCountRow[];
        dau?: AnalyticsDauRow[];
        funnel?: AnalyticsFunnelRow[];
        regions?: AnalyticsRegionRow[];
        os_dist?: AnalyticsOsRow[];
        login_hour?: AnalyticsLoginHourRow[];
        retention?: AnalyticsRetentionRow[];
        first_session?: AnalyticsFirstSessionResult;
        level_funnel?: AnalyticsLevelFunnelRow[];
        tutorial_funnel?: AnalyticsStepFunnelResult;
        scene_funnel?: AnalyticsStepFunnelResult;
        browser_dist?: AnalyticsBrowserRow[];
        device_type_dist?: AnalyticsDeviceTypeRow[];
        geo_dist?: AnalyticsGeoRow[];
        badge_dist?: AnalyticsBadgeDistRow[];
      };
      const body = (await res.json()) as { data: Payload };
      const p = body.data;
      if (!p) return {};
      if (p.type === 'event_counts') return { event_counts: p.counts ?? [] };
      if (p.type === 'dau') return { dau: p.dau ?? [] };
      if (p.type === 'funnel') return { funnel: p.funnel ?? [] };
      if (p.type === 'region_dist') return { region_dist: p.regions ?? [] };
      if (p.type === 'os_dist') return { os_dist: p.os_dist ?? [] };
      if (p.type === 'login_hour') return { login_hour: p.login_hour ?? [] };
      if (p.type === 'retention') return { retention: p.retention ?? [] };
      if (p.type === 'first_session') return { first_session: p.first_session };
      if (p.type === 'level_funnel') return { level_funnel: p.level_funnel ?? [] };
      if (p.type === 'tutorial_funnel') return { tutorial_funnel: p.tutorial_funnel };
      if (p.type === 'scene_funnel') return { scene_funnel: p.scene_funnel };
      if (p.type === 'browser_dist') return { browser_dist: p.browser_dist ?? [] };
      if (p.type === 'device_type_dist') return { device_type_dist: p.device_type_dist ?? [] };
      if (p.type === 'geo_dist') return { geo_dist: p.geo_dist ?? [] };
      if (p.type === 'badge_dist') return { badge_dist: p.badge_dist ?? [] };
      return {};
    } catch (e) {
      log.warn('analytics query failed', { type, err: (e as Error).message });
      return {};
    }
  }
}
