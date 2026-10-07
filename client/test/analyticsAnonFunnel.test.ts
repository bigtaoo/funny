/**
 * analyticsAnonFunnel.test.ts — the anonymous first-session funnel tick (COMPLIANCE_GLOBAL §3.3b).
 *
 * EEA players who never say yes to analytics report nothing else, so `countAnonymousFunnelStep` is
 * the only thing that can say where they drop — and because it counts every player, it is also the
 * one funnel consented and unconsented players can be read on together. What is pinned here is what
 * keeps it a counter and not telemetry: it carries no identity, and it counts each step once per
 * launch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const state = vi.hoisted(() => ({ ticks: [] as Array<{ base: string; platform: string; step: string }> }));

class FakeQueue {
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
  push(): void { /* no-op */ }
  checkpoint(): void { /* no-op */ }
  flushSync(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
}
vi.mock('../src/analytics/queue', () => ({ EventQueue: FakeQueue }));
vi.mock('../src/analytics/config', () => ({
  fetchAnalyticsConfig: vi.fn(async () => {}),
  shouldTrack: vi.fn(() => true),
  pingDeclinedLaunch: vi.fn(),
  pingAnonymousFunnelStep: vi.fn((base: string, platform: string, step: string) => { state.ticks.push({ base, platform, step }); }),
}));

function fakeStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

async function launch(apiBase: string | null = 'https://host/api') {
  vi.resetModules();
  state.ticks.length = 0;
  const analytics = await import('../src/analytics/index');
  await analytics.init({ storage: fakeStorage() } as never, undefined, apiBase);
  return analytics;
}

describe('anonymous first-session funnel tick', () => {
  beforeEach(() => { vi.stubGlobal('document', undefined); vi.stubGlobal('window', undefined); });

  it('ticks each step once per launch, with nothing but the platform and the step', async () => {
    const analytics = await launch();
    analytics.countAnonymousFunnelStep('tutorial_start');
    analytics.countAnonymousFunnelStep('beat_unit');
    analytics.countAnonymousFunnelStep('tutorial_start'); // e.g. "replay tutorial" in the same launch
    expect(state.ticks).toEqual([
      { base: 'https://host', platform: 'web', step: 'tutorial_start' },
      { base: 'https://host', platform: 'web', step: 'beat_unit' },
    ]);
  });

  it('counts every player, whatever their analytics answer', async () => {
    const analytics = await launch();
    analytics.setConsent(true);
    analytics.countAnonymousFunnelStep('tutorial_start');
    analytics.setConsent(false);
    analytics.countAnonymousFunnelStep('graduate');
    expect(state.ticks.map((t) => t.step)).toEqual(['tutorial_start', 'graduate']);
  });

  it('covers the first campaign levels and the tutorial skip', async () => {
    const analytics = await launch();
    analytics.countAnonymousFunnelStep('tutorial_skip');
    analytics.countAnonymousFunnelStep('lv1_start');
    analytics.countAnonymousFunnelStep('lv3_clear');
    expect(state.ticks.map((t) => t.step)).toEqual(['tutorial_skip', 'lv1_start', 'lv3_clear']);
  });

  it('drops a step outside the allow-list instead of sending it', async () => {
    const analytics = await launch();
    analytics.countAnonymousFunnelStep('orientation_o1' as never);
    expect(state.ticks).toEqual([]);
  });

  it('is a no-op offline, where there is no counter to write to', async () => {
    const analytics = await launch(null);
    analytics.countAnonymousFunnelStep('tutorial_start');
    expect(state.ticks).toEqual([]);
  });

  it('a fresh launch counts the same step again', async () => {
    let analytics = await launch();
    analytics.countAnonymousFunnelStep('tutorial_start');
    analytics = await launch();
    analytics.countAnonymousFunnelStep('tutorial_start');
    expect(state.ticks).toHaveLength(1); // launch() clears the log; the second launch ticked once
  });
});
