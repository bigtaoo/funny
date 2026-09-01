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

export async function fetchAnalyticsConfig(analyticsBaseUrl: string): Promise<void> {
  try {
    // Through the transport seam, not the global fetch: the WeChat mini-game has no fetch and
    // installs wx.request behind this (net/transport.ts, ASSET_PACKAGING §4.4).
    const res = await netTransport().request({
      method: 'GET',
      url: `${analyticsBaseUrl}/analytics/config`,
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
