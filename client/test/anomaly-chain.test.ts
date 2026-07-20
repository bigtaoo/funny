// Full end-to-end test for client anomaly reporting (FEATURE_FLAGS_DESIGN §9.7).
//
// Pipeline: client net/anomaly.ts (AnomalyReporter / crash sentinel / exit beacon)
//        --POST /client/anomaly--> server clientAnomaly handler
//        --buildAnomalyLokiPayload--> Loki push line.
//
// The server-handler half (validation / IP rate-limiting / anon fallback / forwarding) is already
// covered by server/metaserver/test/clientLog.test.ts; this test adds coverage for **the client half**
// (previously zero coverage and the fix site for two bugs on 2026-06-27), and feeds the body the client
// actually emits into the server's **real** Loki formatting function buildAnomalyLokiPayload,
// asserting the final Loki line — i.e., the full "client event → Loki line" pipeline.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Full-pipeline seam: the server converts received events to Loki lines using only this pure function (no dependencies; importable directly across packages).
import { buildAnomalyLokiPayload } from '../../server/metaserver/src/clientLog';

const API_BASE = 'https://api.test/api';
const ANOMALY_URL = `${API_BASE}/client/anomaly`;
const PUBLIC_ID = '123456789';
const SENTINEL = 'nw_session_sentinel';

type Captured = {
  fetch: ReturnType<typeof vi.fn>;
  sendBeacon: ReturnType<typeof vi.fn>;
  store: Map<string, string>;
  doc: { visibilityState: string; hidden: boolean };
  fire: (type: string, ev?: unknown) => void;
};

/**
 * Each test case resets modules before importing: AnomalyReporter / crash sentinel / installAnomalyWatchers
 * in anomaly.ts are all module-level singletons with a one-shot installation gate (__nwAnomalyHooked);
 * without isolation they bleed into each other. Globals are injected via vi.stubGlobal
 * (Node's built-in navigator is read-only and throws on direct assignment).
 */
async function freshAnomaly(opts: { base?: string; publicId?: string | null; longTaskObserver?: boolean } = {}): Promise<{
  mod: typeof import('../src/net/anomaly');
  cap: Captured & { fireLongTask?: (entries: Array<{ startTime: number; duration: number }>) => void };
}> {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__nwAnomalyHooked; // release the one-shot installation gate

  const store = new Map<string, string>();
  if (opts.publicId) store.set('nw_player_public_id', opts.publicId);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });

  const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal('fetch', fetchMock);

  const sendBeacon = vi.fn(() => true);
  vi.stubGlobal('navigator', { sendBeacon });

  const doc = { visibilityState: 'visible', hidden: false };
  vi.stubGlobal('document', doc);

  const listeners = new Map<string, Array<(e: unknown) => void>>();
  vi.stubGlobal('addEventListener', (type: string, cb: (e: unknown) => void) => {
    const arr = listeners.get(type) ?? [];
    arr.push(cb);
    listeners.set(type, arr);
  });

  vi.stubGlobal('__NW_API_BASE__', opts.base ?? API_BASE);
  vi.stubGlobal('TARGET', undefined); // platformName() → 'web'

  const cap: Captured & { fireLongTask?: (entries: Array<{ startTime: number; duration: number }>) => void } = {
    fetch: fetchMock,
    sendBeacon,
    store,
    doc,
    fire: (type, ev) => (listeners.get(type) ?? []).forEach((f) => f(ev)),
  };

  // Long Tasks API (Chromium-only): feature-detected via `PerformanceObserver.supportedEntryTypes`.
  // Only stubbed when a test opts in, so existing tests (no PerformanceObserver global) keep
  // exercising the "observer unsupported/inactive" path, unaffected by the new suppression logic.
  if (opts.longTaskObserver) {
    let observerCb: ((list: { getEntries: () => Array<{ startTime: number; duration: number }> }) => void) | null = null;
    class FakePerformanceObserver {
      static supportedEntryTypes = ['longtask'];
      constructor(cb: typeof observerCb) { observerCb = cb; }
      observe(): void { /* no-op: entries are injected manually via cap.fireLongTask */ }
      disconnect(): void { /* no-op */ }
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    cap.fireLongTask = (entries) => observerCb?.({ getEntries: () => entries });
  }

  const mod = await import('../src/net/anomaly');
  return { mod, cap };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Client → POST /client/anomaly (normal batched fetch channel) ───────────────────────────
describe('AnomalyReporter.report → batched POST', () => {
  beforeEach(() => vi.useFakeTimers());

  it('POSTs to /client/anomaly after 1.5s batch window; body shape is correct (publicId/platform/events)', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.reportAnomaly('webgl_lost', 'context lost', { glError: 1282 });
    expect(cap.fetch).not.toHaveBeenCalled(); // not sent within the batch delay
    await vi.advanceTimersByTimeAsync(1500);

    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = cap.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANOMALY_URL);
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body.publicId).toBe(PUBLIC_ID);
    expect(body.platform).toBe('web');
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: 'webgl_lost', msg: 'context lost' });
    expect(typeof body.events[0].ts).toBe('number');
    expect(body.events[0].detail).toContain('1282'); // detail serialized to string
  });

  it('a second report of the same type within the cooldown window is dropped (mem deduped over 60 s)', async () => {
    const { mod, cap } = await freshAnomaly();
    mod.reportAnomaly('mem', 'heap 1');
    mod.reportAnomaly('mem', 'heap 2'); // within cooldown → dropped
    await vi.advanceTimersByTimeAsync(1500);
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].msg).toBe('heap 1');
  });

  it('no baseUrl → no request sent (silently dropped, never affects the player)', async () => {
    const { mod, cap } = await freshAnomaly({ base: '' });
    mod.reportAnomaly('jserror', 'boom');
    await vi.advanceTimersByTimeAsync(1500);
    expect(cap.fetch).not.toHaveBeenCalled();
  });
});

// ── Full-pipeline seam: client body → server Loki formatting → Loki line ──────────────────────────
describe('Full pipeline: client POST events through server buildAnomalyLokiPayload → Loki line', () => {
  beforeEach(() => vi.useFakeTimers());

  it('an event emitted by the client is converted server-side into a single {source,kind=anomaly} stream + logfmt line', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.reportAnomaly('crash', 'previous session ended without clean exit', { aliveMs: 4200 });
    await vi.advanceTimersByTimeAsync(1500);

    // Take the body actually emitted by the client and feed it into the server's real Loki formatting function (what the handler does internally).
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.buildVersion).toBe('0.0.0'); // __NW_BUILD_VERSION__ unbaked in test env
    const payload = buildAnomalyLokiPayload(body.publicId, body.events, body.platform, body.buildVersion, () => '0')!;

    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0].stream).toEqual({ source: 'client', kind: 'anomaly' });
    const line = payload.streams[0].values[0][1];
    expect(line).toContain('type=crash');
    expect(line).toContain(`publicId=${PUBLIC_ID}`);
    expect(line).toContain('platform=web');
    expect(line).toContain('buildVersion=0.0.0');
    expect(line).toContain('detail=');
    expect(line).toContain('msg="previous session ended without clean exit"'); // contains spaces → logfmt quoting
  });
});

// ── Exit capture (regression: 2026-06-27 Bug A — hidden does not set cleanExit) ────────────────────────
describe('Exit beacon and cleanExit flag (Bug A regression)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('visibilitychange→hidden: eager flush sends the queue (uncredentialed keepalive fetch), but does **not** set cleanExit', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.initCrashSentinel();          // start the sentinel for this session (cleanExit not yet set)
    mod.installAnomalyWatchers();     // install exit listeners
    mod.reportAnomaly('anr', 'stall'); // queue one event so there is something to flush on exit

    cap.doc.visibilityState = 'hidden';
    cap.fire('visibilitychange');

    // Eager exit flush is a keepalive fetch, NOT sendBeacon (sendBeacon would be credentialed → blocked by cross-origin CORS).
    expect(cap.sendBeacon).not.toHaveBeenCalled();
    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const init = (cap.fetch.mock.calls[0] as [string, RequestInit])[1];
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
    const sentinel = JSON.parse(cap.store.get(SENTINEL)!);
    expect(sentinel.cleanExit).toBeUndefined(); // key assertion: hidden is not a clean exit (iOS background process may be killed)
  });

  it('pagehide: eager flush (keepalive fetch) fires and cleanExit is set (true unload)', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.initCrashSentinel();
    mod.installAnomalyWatchers();
    mod.reportAnomaly('anr', 'stall');

    cap.fire('pagehide');

    expect(cap.sendBeacon).not.toHaveBeenCalled();
    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const sentinel = JSON.parse(cap.store.get(SENTINEL)!);
    expect(sentinel.cleanExit).toBe(true);
  });

  it('previous sentinel has cleanExit → next startup does not report a crash (no request)', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    cap.store.set(SENTINEL, JSON.stringify({ startedAt: 1000, lastSeenAt: 5000, cleanExit: true }));
    mod.initCrashSentinel();
    expect(cap.fetch).not.toHaveBeenCalled();
    expect(cap.sendBeacon).not.toHaveBeenCalled();
  });
});

// ── ANR watchdog vs. backgrounded-tab throttling (regression: 2026-07-15 false-ANR-on-resume) ─────
describe('ANR watchdog: backgrounded tab does not report a false stall (Bug: hidden sampled, not latched)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('hidden the whole time, but resumes visible just before the delayed tick fires → no ANR reported', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.installAnomalyWatchers();
    await vi.advanceTimersByTimeAsync(1000); // let the watchdog establish its baseline `expected`

    cap.doc.hidden = true;
    cap.fire('visibilitychange');
    vi.setSystemTime(new Date(Date.now() + 20_000)); // jump the clock while hidden; timers stay suspended
    cap.doc.hidden = false;
    cap.fire('visibilitychange'); // tab foregrounded — hidden flips back to false BEFORE the suspended tick runs

    await vi.advanceTimersByTimeAsync(1000); // the overdue interval tick finally executes
    await vi.advanceTimersByTimeAsync(1500); // batch flush window, in case anything was queued

    expect(cap.fetch).not.toHaveBeenCalled();
  });

  it('a genuine stall while the tab stayed visible throughout still reports an ANR', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.installAnomalyWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    vi.setSystemTime(new Date(Date.now() + 20_000)); // tab stays visible; clock jumps as if the main thread froze
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500); // batch flush window

    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.events[0].type).toBe('anr');
  });

  it('anr detail carries the active scene + registered context (GPU counters) for attribution', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.installAnomalyWatchers();
    mod.setActiveScene('WorldMapScene');
    mod.setAnrContextProvider(() => ({ gpu: { tex: 12, baseTex: 1105, tickers: 5 } }));
    await vi.advanceTimersByTimeAsync(1000);

    vi.setSystemTime(new Date(Date.now() + 20_000)); // genuine visible stall
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500);

    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const detail = JSON.parse(body.events[0].detail as string);
    expect(detail.scene).toBe('WorldMapScene');
    expect(detail.gpu.baseTex).toBe(1105);
    expect(detail.stallMs).toBeGreaterThan(4000);
  });

  it('Long Tasks observer active + zero long tasks in the stall window → anr is suppressed (not sent, per FEATURE_FLAGS_DESIGN §9.7 2026-07-20)', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID, longTaskObserver: true });
    mod.installAnomalyWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    vi.setSystemTime(new Date(Date.now() + 20_000)); // genuine visible stall, but Long Tasks API saw nothing
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(cap.fetch).not.toHaveBeenCalled(); // confirmed thread suspension, not app code — suppressed locally
  });

  it('Long Tasks observer active but a long task overlaps the stall window → anr IS still reported with longTaskMs', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID, longTaskObserver: true });
    mod.installAnomalyWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    vi.setSystemTime(new Date(Date.now() + 20_000));
    // Inject a long-task entry overlapping the stall window before the watchdog's tick fires.
    const origin = (globalThis as { performance: { timeOrigin: number } }).performance.timeOrigin;
    cap.fireLongTask?.([{ startTime: Date.now() - origin, duration: 5000 }]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const detail = JSON.parse(body.events[0].detail as string);
    expect(detail.longTaskMs).toBeGreaterThan(0);
    expect(detail.longTaskCount).toBe(1);
  });

  it('a throwing context provider never breaks the anr report', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.installAnomalyWatchers();
    mod.setAnrContextProvider(() => { throw new Error('provider boom'); });
    await vi.advanceTimersByTimeAsync(1000);

    vi.setSystemTime(new Date(Date.now() + 20_000));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(cap.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string).events[0].type).toBe('anr');
  });
});

// ── Crash sentinel catch-up report (regression: 2026-06-27 Bug B — immediate eager flush, no 1.5s batch wait) ────────────────
describe('Crash sentinel immediate eager flush on catch-up report (Bug B regression)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('startup detects previous unclean exit → eager flush sends crash immediately (no need to advance the 1.5s batch timer)', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    // Pre-populate a sentinel indicating the previous session exited abnormally (has startedAt, no cleanExit).
    cap.store.set(
      SENTINEL,
      JSON.stringify({ startedAt: 1000, lastSeenAt: 5000, lastError: 'TypeError x' }),
    );

    mod.initCrashSentinel();

    // Key assertion: the crash report must already have been sent without any timer advancement (otherwise cascading crashes would never fire).
    // Sent via an uncredentialed keepalive fetch, NOT sendBeacon (sendBeacon is credentialed → blocked by cross-origin CORS).
    expect(cap.sendBeacon).not.toHaveBeenCalled();
    expect(cap.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = cap.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANOMALY_URL);
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
    const sent = JSON.parse(init.body as string);
    expect(sent.events.some((e: { type: string }) => e.type === 'crash')).toBe(true);
  });
});
