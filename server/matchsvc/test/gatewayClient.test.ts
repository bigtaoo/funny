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
    expect(JSON.parse(published[0]!.message)).toEqual({ recipients: ['acc-1'], msg: ROOM_STATE });
    expect(global.fetch).not.toHaveBeenCalled();
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
});
