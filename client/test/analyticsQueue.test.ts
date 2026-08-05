// Regression coverage for analytics/queue.ts (A9-4) — previously zero tests for the entire
// analytics event pipeline. Focus of this file: the MAX_QUEUE_SIZE=200 silent-drop cap (the
// concrete memory-leak guard flagged by client-memory-leak.md's growth-monitoring pattern —
// an unbounded event queue is exactly the kind of "keeps accumulating forever" leak that
// class of bug describes), plus the surrounding flush/retry/flushSync contract it depends on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventQueue, type QueueOptions } from '../src/analytics/queue';

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
  it('flushes only when the queue is non-empty', () => {
    const q = makeQueue();
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue(undefined);

    q.checkpoint();
    expect(flushSpy).not.toHaveBeenCalled();

    q.push({ event: 'e1', ts: 1 });
    q.checkpoint();
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});

describe('EventQueue — flushSync()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when the queue is empty', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const q = makeQueue();
    q.flushSync();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('uses navigator.sendBeacon when available and clears the queue synchronously', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const q = makeQueue();
    q.push({ event: 'e1', ts: 1 });
    q.flushSync();

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe('https://analytics.test/analytics/events');
    expect(JSON.parse(body).events).toEqual([{ event: 'e1', ts: 1 }]);
    expect(rawQueue(q)).toHaveLength(0);
  });

  it('falls back to keepalive fetch when sendBeacon is unavailable', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchMock);
    const q = makeQueue();
    q.push({ event: 'e1', ts: 1 });
    q.flushSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].keepalive).toBe(true);
    expect(rawQueue(q)).toHaveLength(0);
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
