/**
 * analyticsBootTimeline.test.ts — the three startup events and the phase arithmetic behind them.
 *
 * What makes these worth a test rather than a read: every one of them is emitted BEFORE
 * `analytics.init()` exists to send it (that is the whole point — they describe the window before
 * the SDK), so the only thing standing between them and silent loss is `track()`'s buffer. `track`
 * is mocked here; the buffer itself is covered by analyticsConsentBuffer.test.ts's pre-init cases.
 *
 * What this file pins is the arithmetic, and in particular that `load_time` reports a *missing*
 * phase as absent rather than as zero. A zero would read as "this step was instant" in the ops mean,
 * which is the opposite of "this platform does not have this step".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
vi.mock('../src/analytics/index', () => ({
  track: (event: string, props: Record<string, unknown> = {}) => { tracked.push({ event, props }); },
}));

/** Drive `elapsed()` by hand: no document → the module reads Date.now() against its own load time. */
let clock = 0;

async function freshTimeline() {
  vi.resetModules();
  tracked.length = 0;
  clock = 0;
  vi.stubGlobal('document', undefined);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  return import('../src/analytics/bootTimeline');
}

const props = (event: string): Record<string, unknown> | undefined => tracked.find((e) => e.event === event)?.props;

describe('boot timeline', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('reports one event per phase that has one, in boot order', async () => {
    const { markBoot } = await freshTimeline();
    for (const phase of ['script', 'renderer', 'preload_start', 'preload_done', 'first_frame', 'ready'] as const) {
      markBoot(phase);
    }
    expect(tracked.map((e) => e.event)).toEqual(['boot', 'first_frame', 'load_time']);
  });

  it('splits the total into the phases that produced it', async () => {
    const { markBoot } = await freshTimeline();
    clock = 40; markBoot('script');
    clock = 140; markBoot('renderer');
    clock = 200; markBoot('first_frame');
    clock = 220; markBoot('preload_start');
    clock = 1220; markBoot('preload_done', { preload_assets: 12 });
    clock = 1500; markBoot('ready');

    expect(props('load_time')).toMatchObject({
      origin: 'script',
      total_ms: 1500,
      to_script_ms: 40,
      renderer_ms: 100,
      first_frame_ms: 200,
      preload_ms: 1000,
      scene_ms: 280,
      preload_assets: 12,
    });
  });

  it('leaves a phase that never ran out of load_time instead of reporting it as zero', async () => {
    const { markBoot } = await freshTimeline();
    clock = 10; markBoot('script');
    clock = 900; markBoot('ready');
    const p = props('load_time')!;
    expect(p.total_ms).toBe(900);
    expect(p.preload_ms).toBeUndefined();
    expect(p.first_frame_ms).toBeUndefined();
  });

  it('keeps the first mark per phase — first_frame is called on every single frame', async () => {
    const { markBoot } = await freshTimeline();
    clock = 0; markBoot('script');
    clock = 50; markBoot('first_frame');
    clock = 60; markBoot('first_frame');
    clock = 70; markBoot('first_frame');
    expect(tracked.filter((e) => e.event === 'first_frame')).toHaveLength(1);
    expect(props('first_frame')).toMatchObject({ total_ms: 50 });
  });

  it('labels its time origin, because the two origins are not comparable', async () => {
    const { markBoot } = await freshTimeline();
    markBoot('script');
    // No document → WeChat-shaped runtime: the timeline starts at module load, so nothing before our
    // own first line is included and to_script_ms is ~0 rather than a download time.
    expect(props('boot')).toMatchObject({ origin: 'script', to_script_ms: 0 });
    expect(props('boot')!.nav_type).toBeUndefined();
  });

  it('reads the navigation + script-resource breakdown where the browser has one', async () => {
    vi.resetModules();
    tracked.length = 0;
    vi.stubGlobal('document', {});
    vi.stubGlobal('performance', {
      now: () => 1234,
      getEntriesByType: (kind: string) =>
        kind === 'navigation'
          ? [{
              type: 'navigate',
              domainLookupStart: 10, domainLookupEnd: 30,
              connectStart: 30, connectEnd: 90, secureConnectionStart: 50,
              requestStart: 90, responseStart: 240, responseEnd: 260,
            }]
          : [
              { initiatorType: 'script', startTime: 300, responseEnd: 900, transferSize: 512 * 1024 },
              { initiatorType: 'img', startTime: 0, responseEnd: 2000, transferSize: 9_000_000 },
            ],
    });
    const { markBoot } = await import('../src/analytics/bootTimeline');
    markBoot('script');

    expect(props('boot')).toEqual({
      origin: 'nav',
      to_script_ms: 1234,
      nav_type: 'navigate',
      dns_ms: 20,
      tcp_ms: 60,
      tls_ms: 40,
      ttfb_ms: 150,
      html_ms: 20,
      js_ms: 600,
      js_files: 1, // the image is not a script and must not be counted as bundle weight
      js_kb: 512,
    });
  });

  it('omits the transferred size when the browser refuses to report it (cache hit / no Timing-Allow-Origin)', async () => {
    vi.resetModules();
    tracked.length = 0;
    vi.stubGlobal('document', {});
    vi.stubGlobal('performance', {
      now: () => 100,
      getEntriesByType: (kind: string) =>
        kind === 'navigation'
          ? [{
              type: 'reload',
              domainLookupStart: 0, domainLookupEnd: 0,
              connectStart: 0, connectEnd: 0, secureConnectionStart: 0,
              requestStart: 0, responseStart: 5, responseEnd: 6,
            }]
          : [{ initiatorType: 'script', startTime: 10, responseEnd: 20, transferSize: 0 }],
    });
    const { markBoot } = await import('../src/analytics/bootTimeline');
    markBoot('script');
    const p = props('boot')!;
    expect(p.js_kb).toBeUndefined();   // absent means "not measurable", never "zero bytes"
    expect(p.tls_ms).toBeUndefined();  // secureConnectionStart 0 → no handshake to attribute
    expect(p.nav_type).toBe('reload'); // a warm reload must not be averaged in with cold launches
  });

  it('survives a runtime whose performance entries throw', async () => {
    vi.resetModules();
    tracked.length = 0;
    vi.stubGlobal('document', {});
    vi.stubGlobal('performance', {
      now: () => 5,
      getEntriesByType: () => { throw new Error('not supported'); },
    });
    const { markBoot } = await import('../src/analytics/bootTimeline');
    expect(() => markBoot('script')).not.toThrow();
    expect(props('boot')).toMatchObject({ origin: 'nav', to_script_ms: 5 });
  });
});
