/**
 * analyticsAnonTutorial.test.ts — the anonymous tutorial-step tick (COMPLIANCE_GLOBAL §3.3).
 *
 * The CrazyGames build plays its first minute before the analytics question is answered (EU/US time
 * zones), so `countAnonymousTutorialStep` is the only thing that can say where those players drop.
 * What is pinned here is what keeps it a counter and not telemetry: it carries no identity, it stops
 * the moment real events can flow, and it counts each step once per launch.
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
  pingAnonymousTutorialStep: vi.fn((base: string, platform: string, step: string) => { state.ticks.push({ base, platform, step }); }),
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

describe('anonymous tutorial tick', () => {
  beforeEach(() => { vi.stubGlobal('document', undefined); vi.stubGlobal('window', undefined); });

  it('ticks each step once per launch, with nothing but the platform and the step', async () => {
    const analytics = await launch();
    analytics.countAnonymousTutorialStep('tutorial_start');
    analytics.countAnonymousTutorialStep('beat_unit');
    analytics.countAnonymousTutorialStep('tutorial_start'); // e.g. "replay tutorial" in the same launch
    expect(state.ticks).toEqual([
      { base: 'https://host', platform: 'web', step: 'tutorial_start' },
      { base: 'https://host', platform: 'web', step: 'beat_unit' },
    ]);
  });

  it('sends nothing once consent is granted — those players report real tutorial events', async () => {
    const analytics = await launch();
    analytics.setConsent(true);
    analytics.countAnonymousTutorialStep('tutorial_start');
    expect(state.ticks).toEqual([]);
  });

  it('starts again after a refusal or a withdrawal', async () => {
    const analytics = await launch();
    analytics.setConsent(true);
    analytics.setConsent(false);
    analytics.countAnonymousTutorialStep('graduate');
    expect(state.ticks.map((t) => t.step)).toEqual(['graduate']);
  });

  it('drops a step outside the allow-list instead of sending it', async () => {
    const analytics = await launch();
    analytics.countAnonymousTutorialStep('orientation_o1' as never);
    expect(state.ticks).toEqual([]);
  });

  it('is a no-op offline, where there is no counter to write to', async () => {
    const analytics = await launch(null);
    analytics.countAnonymousTutorialStep('tutorial_start');
    expect(state.ticks).toEqual([]);
  });

  it('a fresh launch counts the same step again', async () => {
    let analytics = await launch();
    analytics.countAnonymousTutorialStep('tutorial_start');
    analytics = await launch();
    analytics.countAnonymousTutorialStep('tutorial_start');
    expect(state.ticks).toHaveLength(1); // launch() clears the log; the second launch ticked once
  });
});
