// Analytics config cache (A9-4).
// Fetched once at session start from GET /analytics/config.
// On failure: fallback = all disabled (safe degradation per §4.3).

import type { components } from '../net/openapi';
import { netTransport } from '../net/transport';

export type AnalyticsConfig = components['schemas']['AnalyticsConfig'];
export type AnalyticsEventConfig = components['schemas']['AnalyticsEventConfig'];

const DISABLED_FALLBACK: AnalyticsConfig = {
  enabled: false,
  defaultSample: 0,
  events: {},
};

let cached: AnalyticsConfig = DISABLED_FALLBACK;

/**
 * @param platform  Build target, sent as `?p=` purely so the server can keep a per-platform **launch
 *   counter** (ANALYTICS_DESIGN §3.6b). This request is the only one every launch makes before the
 *   age/consent gates, which makes it the only possible denominator for the players who answer
 *   neither and leave — they never reach `session_start`. Nothing identifying is sent, and nothing
 *   identifying may ever be added here: the whole point is a number that needs no consent to count.
 */
export async function fetchAnalyticsConfig(analyticsBaseUrl: string, platform?: string): Promise<void> {
  try {
    // Through the transport seam, not the global fetch: the WeChat mini-game has no fetch and
    // installs wx.request behind this (net/transport.ts, ASSET_PACKAGING §4.4).
    const res = await netTransport().request({
      method: 'GET',
      url: `${analyticsBaseUrl}/analytics/config${platform ? `?p=${encodeURIComponent(platform)}` : ''}`,
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      // analyticsvc wraps responses in the shared { ok, data } envelope; unwrap
      // it here (tolerant of a raw body too, per the OpenAPI contract §8).
      const json = (await res.json()) as unknown;
      cached =
        json && typeof json === 'object' && 'data' in json
          ? ((json as { data: AnalyticsConfig }).data)
          : (json as AnalyticsConfig);
    }
  } catch {
    // network failure → keep disabled fallback
  }
}

/**
 * Tell the launch counter that this launch belongs to a player who refused analytics
 * (ANALYTICS_DESIGN §3.6c) — the same unauthenticated endpoint, plus `&d=1`, and the response is
 * thrown away.
 *
 * This is the only thing the refusal path ever sends, and it is not telemetry: the server bumps one
 * number on the (date, platform) row it already keeps and stores nothing else — no device id, no
 * account, not even a `gdpr_consent` event, which would be an event reporting that events were
 * refused. Without it these launches are invisible in exactly the wrong way: since §3.6c they play
 * the game and report nothing, so they sat in the funnel's `Lost` column mixed in with the players
 * who read the consent dialog and closed the tab.
 *
 * Fire-and-forget: a failure costs a tick in a trend and must never be visible to the player.
 */
export function pingDeclinedLaunch(analyticsBaseUrl: string, platform: string): void {
  void netTransport()
    .request({
      method: 'GET',
      url: `${analyticsBaseUrl}/analytics/config?p=${encodeURIComponent(platform)}&d=1`,
      headers: { Accept: 'application/json' },
    })
    .catch(() => { /* network failure → the tick is simply missing */ });
}

export function getAnalyticsConfig(): AnalyticsConfig {
  return cached;
}

/** Returns true if the event should be recorded based on config + sampling. */
export function shouldTrack(event: string): boolean {
  const cfg = cached;
  if (!cfg.enabled) return false;
  const evtCfg = cfg.events?.[event];
  if (evtCfg && evtCfg.enabled === false) return false;
  const sample = evtCfg?.sample ?? cfg.defaultSample ?? 1;
  return Math.random() < sample;
}
