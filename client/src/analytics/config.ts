// Analytics config cache (A9-4).
// Fetched once at session start from GET /analytics/config.
// On failure: fallback = all disabled (safe degradation per §4.3).

import type { components } from '../net/openapi';

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
    const res = await fetch(`${analyticsBaseUrl}/analytics/config`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      cached = (await res.json()) as AnalyticsConfig;
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
