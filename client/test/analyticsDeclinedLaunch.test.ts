/**
 * analyticsDeclinedLaunch.test.ts — the refusal tick's arithmetic (ANALYTICS_DESIGN §3.6c).
 *
 * `consentGate.test.ts` covers the gate's side of this: refusing sends the tick, a returning
 * refuser sends it again next launch, accepting sends nothing. What lives here is the counting
 * rule itself, which is the part that can go wrong silently — the number this tick produces is
 * subtracted from the launch count in the ops funnel, so "one per launch" is not tidiness, it is
 * the difference between `Lost` being the gate bounce and `Lost` being nonsense.
 *
 * The gate is reached on every entry path (`resolveEntry` on launch AND after login, see
 * createAppCore), so the guard against a second tick is load-bearing and is asserted here rather
 * than inferred from the one call site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const state = vi.hoisted(() => ({ pings: [] as Array<{ base: string; platform: string }> }));

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
  pingDeclinedLaunch: vi.fn((base: string, platform: string) => { state.pings.push({ base, platform }); }),
}));

function fakeStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** A fresh module instance = a fresh launch, which is exactly the unit the tick is counted per. */
async function launch(apiBase: string | null = 'https://host/api') {
  vi.resetModules();
  state.pings.length = 0;
  const analytics = await import('../src/analytics/index');
  await analytics.init({ storage: fakeStorage() } as never, undefined, apiBase);
  return analytics;
}

describe('declined-launch tick', () => {
  beforeEach(() => { vi.stubGlobal('document', undefined); vi.stubGlobal('window', undefined); });

  it('ticks once per launch however often the gate asks', async () => {
    const analytics = await launch();
    analytics.countDeclinedLaunch();
    analytics.countDeclinedLaunch(); // the gate again, e.g. resolveEntry after login
    analytics.countDeclinedLaunch();
    expect(state.pings).toHaveLength(1);
  });

  it('arms again on the next init — a refuser is counted every time they play', async () => {
    const analytics = await launch();
    analytics.countDeclinedLaunch();
    expect(state.pings).toHaveLength(1);

    // A second init on the SAME module instance, which is what `init()`'s reset exists for — going
    // through `launch()` again would hand out a fresh module and assert nothing (it did, until the
    // reset was deleted on purpose and all of this still passed). If the guard survived an init,
    // every launch after a refuser's first would vanish from the refusal column while still being
    // counted as a launch — i.e. quietly reappear inside `Lost`, which is the bug this whole
    // column exists to remove.
    await analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
    analytics.countDeclinedLaunch();
    expect(state.pings).toHaveLength(2);
  });

  it('sends nothing offline, where there is no counter to write to', async () => {
    const analytics = await launch(null);
    expect(() => analytics.countDeclinedLaunch()).not.toThrow();
    expect(state.pings).toEqual([]);
  });

  it('writes to the analytics host derived from the API base, not the API base itself', async () => {
    const analytics = await launch('https://host/api');
    analytics.countDeclinedLaunch();
    // Caddy routes /analytics* to analyticsvc, so the `/api` suffix has to come off — the same
    // derivation the config fetch uses, asserted because this call site does it independently.
    expect(state.pings[0]?.base).toBe('https://host');
  });

  it('reports the build target it runs as, so WeChat launches land in the WeChat row', async () => {
    vi.stubGlobal('TARGET', 'wechat');
    const analytics = await launch();
    analytics.countDeclinedLaunch();
    expect(state.pings[0]?.platform).toBe('wechat');
    vi.unstubAllGlobals();
  });
});
