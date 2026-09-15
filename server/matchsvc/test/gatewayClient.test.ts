// GatewayClient push routing (2026-07-18): redis fan-out when available (multi-instance safe),
// falls back to direct HTTP otherwise. Uses a fake fetch since postInternal wraps global fetch.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient, type PublishRedis } from '../src/gatewayClient';
import type { PushMsg } from '../src/Matchsvc';

const ROOM_STATE: PushMsg = { kind: 'room_state', code: 'ABCD', players: [], phase: 0 };

function fakeRedis(publish: (channel: string, message: string) => Promise<unknown>): PublishRedis {
  return { publish };
}

describe('GatewayClient.push', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('redis available: publishes {recipients:[accountId], msg} on GW_PUSH_REDIS_CHANNEL, no HTTP call', async () => {
    const published: { channel: string; message: string }[] = [];
    const redis = fakeRedis(async (channel, message) => {
      published.push({ channel, message });
    });
    const client = new GatewayClient('http://gateway:8090', 'key', redis);
    client.push('acc-1', ROOM_STATE, 'room-1');
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget async settle

    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe('nw:gw:push');
    // roomId rides along for cross-process log correlation (comm-audit-internal-2026-07-28).
    expect(JSON.parse(published[0]!.message)).toEqual({ recipients: ['acc-1'], msg: ROOM_STATE, roomId: 'room-1' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('redis publish reaches 0 subscribers: falls back to direct HTTP (P0-2 — gateway restart window)', async () => {
    // ioredis publish() resolves with the subscriber count; 0 means no gateway is listening —
    // treating that as delivered used to strand players on match_found.
    const redis = fakeRedis(async () => 0);
    const client = new GatewayClient('http://gateway:8090', 'key', redis);
    client.push('acc-1', ROOM_STATE, 'room-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/gw/push');
  });

  it('redis publish throws: falls back to direct HTTP', async () => {
    const redis = fakeRedis(async () => {
      throw new Error('connection reset');
    });
    const client = new GatewayClient('http://gateway:8090', 'key', redis);
    client.push('acc-1', ROOM_STATE, 'room-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/gw/push');
  });

  it('no redis configured: goes straight to direct HTTP (single-instance behavior unchanged)', async () => {
    const client = new GatewayClient('http://gateway:8090', 'key', null);
    client.push('acc-1', ROOM_STATE, 'room-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('neither redis nor baseUrl configured: available is false, push is a silent no-op', async () => {
    const client = new GatewayClient(null, 'key', null);
    expect(client.available).toBe(false);
    client.push('acc-1', ROOM_STATE);
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('redis available, no roomId passed: publishes without a roomId field (the omitted-roomId ternary branch)', async () => {
    const published: { channel: string; message: string }[] = [];
    const redis = fakeRedis(async (channel, message) => {
      published.push({ channel, message });
      return 1; // one subscriber, delivered
    });
    const client = new GatewayClient('http://gateway:8090', 'key', redis);
    client.push('acc-1', ROOM_STATE); // no roomId (3rd arg omitted)
    await new Promise((r) => setTimeout(r, 0));

    expect(published).toHaveLength(1);
    const parsed = JSON.parse(published[0]!.message) as Record<string, unknown>;
    expect(parsed).toEqual({ recipients: ['acc-1'], msg: ROOM_STATE }); // no `roomId` key at all
    expect('roomId' in parsed).toBe(false);
  });

  it('match_found messages take the retries=2 branch (dedup-safe retry) on the direct HTTP fallback path', async () => {
    const MATCH_FOUND: PushMsg = { kind: 'match_found', gameUrl: 'ws://game:1/ws', ticket: 'tkt' };
    const client = new GatewayClient('http://gateway:8090', 'key', null); // no redis -> straight to HTTP
    client.push('acc-1', MATCH_FOUND, 'room-9');
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1); // succeeds on the first attempt (fetch mock returns 200)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/gw/push');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ accountId: 'acc-1', msg: MATCH_FOUND, roomId: 'room-9' });
  });

  // Give-up severity per kind (2026-09-15). The whole restart-window ERROR cluster in Loki was this one
  // call: matchsvc rehydrates a queue entry seconds after boot, pushes queue_state, redis has no
  // subscriber yet and the direct-HTTP fallback hits a gateway that has not bound :8090 yet. The next
  // tick delivers it. Asserted through the console because the logger is module scope here — and the
  // console is where an operator actually reads the level, so it is the honest place to assert it.
  describe('give-up severity when the gateway is unreachable', () => {
    let errors: unknown[][];
    let warns: unknown[][];
    beforeEach(() => {
      errors = [];
      warns = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
      vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a); });
      global.fetch = vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a self-healing kind (room_state) gives up at warn, not error', async () => {
      const client = new GatewayClient('http://gateway:8090', 'key', null);
      client.push('acc-1', ROOM_STATE);
      await new Promise((r) => setTimeout(r, 0));

      expect(warns.some((a) => String(a[0]).includes('self-healing'))).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('match_found still gives up at error — nothing re-sends it', async () => {
      const MATCH_FOUND: PushMsg = { kind: 'match_found', gameUrl: 'ws://game:1/ws', ticket: 'tkt' };
      const client = new GatewayClient('http://gateway:8090', 'key', null);
      client.push('acc-1', MATCH_FOUND);
      await new Promise((r) => setTimeout(r, 400)); // retries=2 with the default 150ms backoff

      expect(errors.some((a) => String(a[0]).includes('internal POST failed'))).toBe(true);
    });
  });
});
