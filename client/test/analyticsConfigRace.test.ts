/**
 * analyticsConfigRace.test.ts — consent granted while `GET /analytics/config` is still in flight.
 *
 * The CrazyGames reviewer's session (CRAZYGAMES_LAUNCH §7, ONBOARDING_DESIGN §11.9) reached the
 * server with `session_start` but no `boot` / `first_frame` / `load_time` and no `gdpr_consent`,
 * while their save said consent was true. Root cause: `init()` published the event queue BEFORE
 * awaiting the sampling config, and both `track()` and the pre-consent replay treat "queue is set"
 * as "ready" — so they sampled through `shouldTrack()` while it still answered from the disabled
 * fallback, and dropped everything. On CrazyGames the consent gate is the first screen and a QA
 * tester answers it in about a second, i.e. inside that window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const state = vi.hoisted(() => ({
  pushed: [] as Array<{ event: string }>,
  configLoaded: false,
  releaseConfig: null as null | (() => void),
}));

class FakeQueue {
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
  push(e: { event: string }): void { state.pushed.push(e); }
  checkpoint(): void { /* no-op */ }
  flushSync(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
}
vi.mock('../src/analytics/queue', () => ({ EventQueue: FakeQueue }));
vi.mock('../src/analytics/config', () => ({
  // Held open until the test releases it — the "config request still in flight" window.
  fetchAnalyticsConfig: vi.fn(() => new Promise<void>((resolve) => {
    state.releaseConfig = () => { state.configLoaded = true; resolve(); };
  })),
  // The real shouldTrack() answers from DISABLED_FALLBACK (enabled:false) until the config lands.
  shouldTrack: vi.fn(() => state.configLoaded),
  pingDeclinedLaunch: vi.fn(),
  pingAnonymousFunnelStep: vi.fn(),
}));

function fakeStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** Let every pending microtask/IO tick run (device-id lookup etc.) without releasing the config. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('consent inside the config-fetch window', () => {
  beforeEach(() => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    state.pushed.length = 0;
    state.configLoaded = false;
    state.releaseConfig = null;
  });

  it('keeps the boot timeline and the consent event when the player accepts before the config arrives', async () => {
    vi.resetModules();
    const analytics = await import('../src/analytics/index');
    analytics.track('boot', { origin: 'nav' });
    const initDone = analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
    analytics.track('load_time', { total_ms: 900 });
    await settle(); // device id resolved, config request still open
    expect(state.releaseConfig, 'the config request must still be in flight here').not.toBeNull();

    // The gate's accept path: consent on, then the consent event, then the first gameplay event.
    analytics.setConsent(true);
    analytics.track('gdpr_consent', { granted: true });
    analytics.track('tutorial_start', {});
    expect(state.pushed, 'nothing may be sampled against the fallback config').toEqual([]);

    state.releaseConfig!();
    await initDone;
    const names = state.pushed.map((e) => e.event);
    expect(names).toEqual(['boot', 'load_time', 'gdpr_consent', 'tutorial_start', 'session_start']);
  });

  it('a returning (already consented) player loses nothing tracked during the window either', async () => {
    vi.resetModules();
    const analytics = await import('../src/analytics/index');
    analytics.setConsent(true);
    const initDone = analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
    await settle();
    analytics.track('screen_view', { scene: 'LobbyScene' });
    state.releaseConfig!();
    await initDone;
    // (nav_checkpoint is tracked from inside screen_view's own track() call, so it lands first.)
    expect(state.pushed.map((e) => e.event)).toEqual(['nav_checkpoint', 'screen_view', 'session_start']);
  });
});
