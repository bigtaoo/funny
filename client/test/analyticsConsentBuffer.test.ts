/**
 * analyticsConsentBuffer.test.ts — what a brand-new player does before accepting the consent
 * dialog still has to reach the funnel once they accept.
 *
 * The boot order for a first-time player is `goIntro() → age gate → consent dialog`
 * (app/createAppCore.ts `start()`), so every pre-lobby event is tracked while consent is still
 * false. Until 2026-09-20 `track()` returned early in that state and only `session_start` was
 * re-emitted on accept, which meant `intro_complete`/`intro_skip` and the IntroScene
 * `nav_checkpoint` were discarded for 100% of new users — the exact cohort the onboarding funnel
 * (ANALYTICS_DESIGN §9.6) is built to measure. It was invisible in the data too: the funnel did not
 * look broken, it looked like everyone quit during the intro.
 *
 * The privacy position is unchanged and is asserted here: pre-consent events live in memory only
 * and are dropped, never sent, if consent never arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const state = vi.hoisted(() => ({
  pushed: [] as Array<{ event: string; props?: Record<string, unknown> }>,
  sampled: new Set<string>(), // events shouldTrack() lets through; empty set = allow all
}));

class FakeQueue {
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
  push(e: { event: string; ts: number; props?: Record<string, unknown> }): void { state.pushed.push(e); }
  checkpoint(): void { /* no-op */ }
  flushSync(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
}
vi.mock('../src/analytics/queue', () => ({ EventQueue: FakeQueue }));
vi.mock('../src/analytics/config', () => ({
  fetchAnalyticsConfig: vi.fn(async () => {}),
  shouldTrack: vi.fn((e: string) => state.sampled.size === 0 || state.sampled.has(e)),
}));

function fakeStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

async function freshAnalytics() {
  vi.resetModules();
  state.pushed.length = 0;
  state.sampled.clear();
  const analytics = await import('../src/analytics/index');
  await analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
  return analytics;
}

const names = () => state.pushed.map((e) => e.event);

describe('pre-consent buffer', () => {
  beforeEach(() => { vi.stubGlobal('document', undefined); vi.stubGlobal('window', undefined); });

  it('sends nothing before consent — not even session_start', async () => {
    const analytics = await freshAnalytics();
    analytics.track('screen_view', { scene: 'IntroScene' });
    analytics.track('intro_complete', {});
    expect(state.pushed).toEqual([]);
  });

  it('replays the whole pre-consent session on accept, intro events included', async () => {
    const analytics = await freshAnalytics();
    analytics.track('screen_view', { scene: 'IntroScene' });
    analytics.track('intro_skip', {});

    analytics.setConsent(true);

    // session_start (from init) + the IntroScene screen_view and its nav_checkpoint companion
    // + intro_skip. The last one is the whole point: it is the funnel's `intro_seen` step.
    expect(names()).toContain('session_start');
    expect(names()).toContain('intro_skip');
    expect(names()).toContain('nav_checkpoint');
    expect(state.pushed.find((e) => e.event === 'nav_checkpoint')?.props).toEqual({ scene: 'IntroScene' });
  });

  it('drops the buffer if consent never comes', async () => {
    const analytics = await freshAnalytics();
    analytics.track('intro_complete', {});
    analytics.setConsent(false);
    analytics.setConsent(true); // e.g. a later accept in the same process
    expect(names()).not.toContain('intro_complete');
  });

  it('applies each event\'s own sampling rate at replay time, not a blanket pass', async () => {
    const analytics = await freshAnalytics();
    state.sampled.add('intro_complete'); // everything else is sampled out
    analytics.track('intro_complete', {});
    analytics.track('screen_view', { scene: 'IntroScene' });
    analytics.setConsent(true);
    expect(names()).toEqual(['intro_complete']);
  });

  it('a returning player who consents before init still gets their session_start', async () => {
    // createAppCore calls setConsent(persisted flag) on the line *above* init().
    vi.resetModules();
    state.pushed.length = 0;
    state.sampled.clear();
    const analytics = await import('../src/analytics/index');
    analytics.setConsent(true);
    await analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
    expect(names()).toContain('session_start');
  });

  it('keeps the earliest events when the buffer overflows', async () => {
    const analytics = await freshAnalytics();
    for (let i = 0; i < 200; i++) analytics.track('level_attempt', { level_id: `lv${i}` });
    analytics.setConsent(true);
    // session_start + 99 more = the 100-event cap, and the survivors are the oldest ones.
    expect(state.pushed).toHaveLength(100);
    expect(state.pushed[0]?.event).toBe('session_start');
    expect(state.pushed[99]?.props).toEqual({ level_id: 'lv98' });
  });
});
