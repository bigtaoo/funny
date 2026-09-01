// Regression coverage for analytics/index.ts's session lifecycle (bindSessionLifecycle /
// onAppHidden / endSession) — previously zero tests touched this file at all. The wx.onHide/
// onShow branch has been correct since the original A9 commit (2026-06-19), but nothing would
// have caught it regressing; this closes that gap for the shared platform/appLifecycle.ts wiring
// (extracted 2026-09-01, see appLifecycle.test.ts for the module's own unit coverage).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const state = vi.hoisted(() => ({
  pushed: [] as Array<{ event: string; props?: Record<string, unknown> }>,
  flushSyncCalls: 0,
}));

class FakeQueue {
  start(): void { /* no-op — the timer isn't what this file tests */ }
  stop(): void { /* no-op */ }
  push(e: { event: string; ts: number; props?: Record<string, unknown> }): void { state.pushed.push(e); }
  checkpoint(): void { /* no-op */ }
  flushSync(): void { state.flushSyncCalls++; }
  async flush(): Promise<void> { /* no-op */ }
}
vi.mock('../src/analytics/queue', () => ({ EventQueue: FakeQueue }));
vi.mock('../src/analytics/config', () => ({
  fetchAnalyticsConfig: vi.fn(async () => {}),
  shouldTrack: vi.fn(() => true),
}));

function fakeStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** Mirrors analyticsQueue.test.ts's stubDom() — see that file for why: exercises the real
 *  platform/appLifecycle.ts module rather than mocking it, so this file and the queue's own
 *  lifecycle test both prove the shared implementation, not a stand-in for it. */
function stubDom() {
  const docListeners = new Map<string, Array<() => void>>();
  const winListeners = new Map<string, Array<() => void>>();
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (t: string, cb: () => void) => {
      docListeners.set(t, [...(docListeners.get(t) ?? []), cb]);
    },
  };
  const win = {
    addEventListener: (t: string, cb: () => void) => {
      winListeners.set(t, [...(winListeners.get(t) ?? []), cb]);
    },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  return {
    hide: () => { doc.visibilityState = 'hidden'; (docListeners.get('visibilitychange') ?? []).forEach((f) => f()); },
    show: () => { doc.visibilityState = 'visible'; (docListeners.get('visibilitychange') ?? []).forEach((f) => f()); },
    unload: () => (winListeners.get('beforeunload') ?? []).forEach((f) => f()),
  };
}

async function initAnalytics() {
  vi.resetModules();
  state.pushed.length = 0;
  state.flushSyncCalls = 0;
  const analytics = await import('../src/analytics/index');
  await analytics.init({ storage: fakeStorage() } as never, undefined, 'https://host/api');
  analytics.setConsent(true); // gate open — init() itself ran with consent still false
  state.pushed.length = 0; // drop the session_start re-emitted by setConsent; irrelevant here
  return analytics;
}

describe('analytics session lifecycle — churn_signal / session_end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('visibilitychange→hidden emits churn_signal(reason: background) then session_end, and flushes', async () => {
    const dom = stubDom();
    await initAnalytics();

    dom.hide();

    expect(state.pushed.map((e) => e.event)).toEqual(['churn_signal', 'session_end']);
    expect(state.pushed[0]!.props!['reason']).toBe('background');
    expect(state.flushSyncCalls).toBe(1);
  });

  it('beforeunload emits churn_signal(reason: explicit_exit) — distinct from a plain background hide', async () => {
    const dom = stubDom();
    await initAnalytics();

    dom.unload();

    expect(state.pushed[0]).toMatchObject({ event: 'churn_signal', props: { reason: 'explicit_exit' } });
  });

  it('only fires once per hide — a second hide before returning to foreground is a no-op', async () => {
    const dom = stubDom();
    await initAnalytics();

    dom.hide();
    dom.hide();

    expect(state.pushed.filter((e) => e.event === 'churn_signal')).toHaveLength(1);
  });

  it('returning to the foreground re-arms — the next hide fires churn_signal again', async () => {
    const dom = stubDom();
    await initAnalytics();

    dom.hide();
    dom.show();
    dom.hide();

    expect(state.pushed.filter((e) => e.event === 'churn_signal')).toHaveLength(2);
  });

  it('on WeChat (no DOM), wx.onHide alone drives the same churn_signal(background) path', async () => {
    let hideCb: (() => void) | undefined;
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('wx', { onHide: (cb: () => void) => { hideCb = cb; } });

    await initAnalytics();
    hideCb!();

    expect(state.pushed[0]).toMatchObject({ event: 'churn_signal', props: { reason: 'background' } });
    expect(state.flushSyncCalls).toBe(1);
  });
});
