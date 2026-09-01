// Regression coverage for analytics/queue.ts (A9-4) — previously zero tests for the entire
// analytics event pipeline. Focus of this file: the MAX_QUEUE_SIZE=200 silent-drop cap (the
// concrete memory-leak guard flagged by client-memory-leak.md's growth-monitoring pattern —
// an unbounded event queue is exactly the kind of "keeps accumulating forever" leak that
// class of bug describes), plus the surrounding flush/retry/flushSync contract it depends on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventQueue, type QueueOptions } from '../src/analytics/queue';
import type { NetRequest } from '../src/net/transport';

function makeQueue(overrides: Partial<QueueOptions> = {}): EventQueue {
  return new EventQueue({
    analyticsBaseUrl: 'https://analytics.test',
    getToken: () => undefined,
    getBatchMeta: () => ({
      session_id: 's1',
      device_id: 'd1',
      platform: 'web',
      os: 'test',
      game_version: '1.0.0',
      locale: 'en',
      consent: true,
    }),
    ...overrides,
  });
}

function rawQueue(q: EventQueue): unknown[] {
  return (q as unknown as { queue: unknown[] }).queue;
}

describe('EventQueue — MAX_QUEUE_SIZE cap', () => {
  it('silently drops events once the queue reaches 200, instead of growing unbounded', () => {
    const q = makeQueue();
    // Neuter auto-flush (fires once length hits the 50-event threshold) so this test can
    // observe the raw queue depth without it being drained mid-run by a real network call.
    q.flush = vi.fn(async () => {});

    for (let i = 0; i < 250; i++) q.push({ event: `e${i}`, ts: i });

    expect(rawQueue(q)).toHaveLength(200);
    // The events kept are the first 200 (drop-newest, not drop-oldest / no eviction).
    expect((rawQueue(q)[0] as { event: string }).event).toBe('e0');
    expect((rawQueue(q)[199] as { event: string }).event).toBe('e199');
  });
});

describe('EventQueue — flush-size threshold', () => {
  it('push() triggers an automatic flush once the queue reaches 50 events', () => {
    const q = makeQueue();
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue(undefined);

    for (let i = 0; i < 49; i++) q.push({ event: 'e', ts: i });
    expect(flushSpy).not.toHaveBeenCalled();

    q.push({ event: 'e', ts: 49 });
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});

describe('EventQueue — flush()', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when the queue is empty (no network call)', async () => {
    const q = makeQueue();
    await q.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the batch, clears the queue on success, and includes an Authorization header when a token is present', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const q = makeQueue({ getToken: () => 'tok123' });
    q.push({ event: 'e1', ts: 1 });
    await q.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://analytics.test/analytics/events');
    expect(init.headers.Authorization).toBe('Bearer tok123');
    const body = JSON.parse(init.body);
    expect(body.events).toEqual([{ event: 'e1', ts: 1 }]);
    expect(body.consent).toBe(true);
    expect(rawQueue(q)).toHaveLength(0);
  });

  it('on network failure, puts the events back for retry (up to MAX_RETRIES)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const q = makeQueue();
    q.push({ event: 'e1', ts: 1 });

    await q.flush();
    expect(rawQueue(q)).toHaveLength(1); // put back

    await q.flush();
    await q.flush();
    await q.flush();
    // 4 total failures > MAX_RETRIES(3) → the 4th failure gives up and drops instead of re-queuing.
    expect(rawQueue(q)).toHaveLength(0);
  });

  it('a subsequent success resets the retry counter', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const q = makeQueue();
    q.push({ event: 'e1', ts: 1 });
    await q.flush(); // fails once, requeued

    fetchMock.mockResolvedValue({ ok: true });
    await q.flush(); // succeeds
    expect(rawQueue(q)).toHaveLength(0);
  });
});

describe('EventQueue — checkpoint()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('flushes only when the queue is non-empty AND a token exists', () => {
    const q = makeQueue({ getToken: () => 'jwt' });
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue(undefined);

    q.checkpoint();
    expect(flushSpy).not.toHaveBeenCalled();

    q.push({ event: 'e1', ts: 1 });
    q.checkpoint();
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('does not flush while the player is still anonymous', () => {
    // Regression (2026-08-24): `user_id` is resolved per BATCH from the Authorization header at
    // ingest, so an early flush permanently stamps everything queued so far as anonymous. The first
    // screen_view — which is what calls checkpoint() — lands within the opening seconds, before
    // login has finished, so this checkpoint kept racing the login it was queued alongside and
    // session_start went out unattributed 355 times against 128 identified in prod.
    const q = makeQueue({ getToken: () => undefined });
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue(undefined);

    q.push({ event: 'session_start', ts: 1 });
    q.checkpoint();

    expect(flushSpy).not.toHaveBeenCalled();
    // Deferred, not dropped — the timer, the size threshold and the unload flush all still fire.
    expect(rawQueue(q)).toHaveLength(1);
  });
});

describe('EventQueue — flushSync()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when the queue is empty', () => {
    const beacon = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    const q = makeQueue();
    q.flushSync();
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token on the unload path — the whole point of not using sendBeacon', () => {
    // Regression (2026-08-24). sendBeacon cannot set headers at all, so while this path used it,
    // every event that only ever leaves on hide/unload was recorded anonymously 100% of the time:
    // prod held 2848 session_end and 2848 churn_signal rows and not one was attributable to a
    // player, while events riding a periodic flush were attributed fine.
    const beacon = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    const q = makeQueue({ getToken: () => 'jwt-token' });
    q.push({ event: 'session_end', ts: 1 });
    q.flushSync();

    expect(beacon).not.toHaveBeenCalled(); // even though it was available
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://analytics.test/analytics/events');
    expect(init.keepalive).toBe(true);
    expect(init.headers['Authorization']).toBe('Bearer jwt-token');
    // A wildcard access-control-allow-origin is invalid for a credentialed request, so cookies
    // must stay off or the browser rejects the response outright.
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body).events).toEqual([{ event: 'session_end', ts: 1 }]);
    expect(rawQueue(q)).toHaveLength(0);
  });

  it('omits the header entirely when anonymous, rather than sending an empty one', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchMock);
    const q = makeQueue({ getToken: () => undefined });
    q.push({ event: 'e1', ts: 1 });
    q.flushSync();

    expect(fetchMock.mock.calls[0]![1].headers['Authorization']).toBeUndefined();
  });

  it('sends through the installed transport in a runtime with no fetch — WeChat, where this used to be a silent no-op', async () => {
    // Replaces a 'falls back to sendBeacon where fetch does not exist' case (2026-09-01,
    // ASSET_PACKAGING §4.5). That fallback was dead everywhere: every platform that has
    // `navigator.sendBeacon` also has `fetch`, and the one runtime that has neither — the WeChat
    // mini-game — got nothing at all. It now gets a real wx.request via net/transport.ts, and
    // unlike a beacon that send carries the Authorization header (the whole point of this method).
    const { setNetTransport, fetchTransport } = await import('../src/net/transport');
    const beacon = vi.fn();
    const request = vi.fn(async (_req: NetRequest) => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', undefined);
    setNetTransport({ request });

    const q = makeQueue({ getToken: () => 'jwt' });
    q.push({ event: 'e1', ts: 1 });
    q.flushSync();

    expect(beacon).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    const req = request.mock.calls[0]![0]!;
    expect(req).toMatchObject({ method: 'POST', url: 'https://analytics.test/analytics/events', keepalive: true, credentials: 'omit' });
    expect(req.headers['Authorization']).toBe('Bearer jwt');
    expect(JSON.parse(req.body!).events).toEqual([{ event: 'e1', ts: 1 }]);
    expect(rawQueue(q)).toHaveLength(0);
    setNetTransport(fetchTransport);
  });
});

describe('EventQueue — start()/stop() timer lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('start() schedules a periodic flush; stop() cancels it', () => {
    const q = makeQueue();
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue(undefined);
    q.start();

    vi.advanceTimersByTime(30_000);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    q.stop();
    vi.advanceTimersByTime(60_000);
    expect(flushSpy).toHaveBeenCalledTimes(1); // no further calls after stop()
  });

  it('stop() before start() (or called twice) does not throw', () => {
    const q = makeQueue();
    expect(() => q.stop()).not.toThrow();
    q.start();
    q.stop();
    expect(() => q.stop()).not.toThrow();
  });
});
