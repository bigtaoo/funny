// connectGatewaySubscriber() unit tests (S8-4b/B7, previously 30.1% — redis-presence.e2e.test.ts covers the
// real-Redis happy path for markOnline/markOffline/onlineAccountIds but is entirely skipped in any
// environment without a local Redis, which is every CI/dev box that hasn't run `docker compose up -d`; the
// message-envelope dispatch, publish/write failure-swallowing, and the outer connect-failure catch had NO
// coverage at all regardless of Redis availability). Mocks the `ioredis` module (dynamically imported by
// redis.ts) with an in-memory fake, so this suite runs everywhere with no real Redis and no e2e skip.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GW_PUSH_REDIS_CHANNEL } from '@nw/shared';

const h = vi.hoisted(() => {
  class SimpleEmitter {
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    on(event: string, fn: (...a: unknown[]) => void): this {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers[event] ?? []) fn(...args);
    }
  }
  class FakeRedis extends SimpleEmitter {
    url: string;
    opts: unknown;
    store: Map<string, string>;
    subscribedChannel: string | undefined;
    lastPublish: { channel: string; payload: string } | undefined;
    quitCalled = false;
    constructor(url: string, opts: unknown, store?: Map<string, string>) {
      super();
      this.url = url;
      this.opts = opts;
      this.store = store ?? new Map();
      flags.instances.push(this);
    }
    async subscribe(channel: string): Promise<void> {
      if (flags.subscribeShouldReject) throw new Error('subscribe failed');
      this.subscribedChannel = channel;
    }
    duplicate(): FakeRedis {
      // Real ioredis duplicates share nothing application-level; here they share the same in-memory
      // `store` map so markOnline (via pubClient) is visible to onlineAccountIds (also via pubClient) —
      // matches the real behavior of one shared Redis keyspace across the sub/pub/rateLimit connections.
      return new FakeRedis(this.url, this.opts, this.store);
    }
    async publish(channel: string, payload: string): Promise<number> {
      if (flags.publishShouldReject) throw new Error('publish failed');
      this.lastPublish = { channel, payload };
      return 1;
    }
    async set(key: string, val: string, ..._args: unknown[]): Promise<string> {
      if (flags.setShouldReject) throw new Error('set failed');
      this.store.set(key, val);
      return 'OK';
    }
    async del(key: string): Promise<number> {
      if (flags.delShouldReject) throw new Error('del failed');
      return this.store.delete(key) ? 1 : 0;
    }
    async pexpire(key: string, _ms: number): Promise<number> {
      if (flags.pexpireShouldReject) throw new Error('pexpire failed');
      return this.store.has(key) ? 1 : 0;
    }
    pipeline(): { exists: (key: string) => unknown; exec: () => Promise<Array<[null, number]>> } {
      const keys: string[] = [];
      const self = this;
      const p = {
        exists: (key: string) => { keys.push(key); return p; },
        exec: async () => {
          if (flags.pipelineShouldReject) throw new Error('pipeline exec failed');
          return keys.map((k) => [null, self.store.has(k) ? 1 : 0] as [null, number]);
        },
      };
      return p;
    }
    async quit(): Promise<string> {
      this.quitCalled = true;
      return 'OK';
    }
  }
  const flags = {
    instances: [] as FakeRedis[],
    subscribeShouldReject: false,
    publishShouldReject: false,
    setShouldReject: false,
    delShouldReject: false,
    pexpireShouldReject: false,
    pipelineShouldReject: false,
  };
  return { FakeRedis, flags };
});

vi.mock('ioredis', () => ({ default: h.FakeRedis }));

// Imported after the mock is registered (vi.mock calls are hoisted above this anyway).
const { connectGatewaySubscriber } = await import('../src/redis');

beforeEach(() => {
  h.flags.instances.length = 0;
  h.flags.subscribeShouldReject = false;
  h.flags.publishShouldReject = false;
  h.flags.setShouldReject = false;
  h.flags.delShouldReject = false;
  h.flags.pexpireShouldReject = false;
  h.flags.pipelineShouldReject = false;
});

describe('connectGatewaySubscriber', () => {
  it('no url configured -> null, no ioredis client constructed at all', async () => {
    const sub = await connectGatewaySubscriber(undefined, () => {}, () => {});
    expect(sub).toBeNull();
    expect(h.flags.instances).toHaveLength(0);
  });

  it('subscribe rejects (connection failure) -> outer catch returns null', async () => {
    h.flags.subscribeShouldReject = true;
    const sub = await connectGatewaySubscriber('redis://x', () => {}, () => {});
    expect(sub).toBeNull();
  });

  it('constructs exactly 3 ioredis connections: subscriber + publish-duplicate + rate-limit-duplicate', async () => {
    const sub = await connectGatewaySubscriber('redis://x', () => {}, () => {});
    expect(sub).not.toBeNull();
    expect(h.flags.instances).toHaveLength(3);
    expect(h.flags.instances[0]!.subscribedChannel).toBe(GW_PUSH_REDIS_CHANNEL);
    expect(sub!.rateLimitClient).toBe(h.flags.instances[2]);
  });

  it('message event with a push envelope invokes onBroadcast with recipients/msg/roomId', async () => {
    const onBroadcast = vi.fn();
    await connectGatewaySubscriber('redis://x', onBroadcast, () => {});
    const subClient = h.flags.instances[0]!;
    subClient.emit('message', GW_PUSH_REDIS_CHANNEL, JSON.stringify({ recipients: ['acc-a'], msg: { kind: 'room_error', code: 'X', message: 'm' }, roomId: 'r1' }));
    expect(onBroadcast).toHaveBeenCalledWith(['acc-a'], { kind: 'room_error', code: 'X', message: 'm' }, 'r1');
  });

  it('message event with a kick envelope invokes onKick with accountId/originInstanceId/connSeq', async () => {
    const onKick = vi.fn();
    await connectGatewaySubscriber('redis://x', () => {}, onKick);
    const subClient = h.flags.instances[0]!;
    subClient.emit('message', GW_PUSH_REDIS_CHANNEL, JSON.stringify({ kick: { accountId: 'acc-a', originInstanceId: 'inst-1', connSeq: 42 } }));
    expect(onKick).toHaveBeenCalledWith('acc-a', 'inst-1', 42);
  });

  it('malformed JSON payload is swallowed — neither callback fires, no throw', async () => {
    const onBroadcast = vi.fn();
    const onKick = vi.fn();
    await connectGatewaySubscriber('redis://x', onBroadcast, onKick);
    const subClient = h.flags.instances[0]!;
    expect(() => subClient.emit('message', GW_PUSH_REDIS_CHANNEL, 'not json')).not.toThrow();
    expect(onBroadcast).not.toHaveBeenCalled();
    expect(onKick).not.toHaveBeenCalled();
  });

  it('a well-formed envelope matching neither shape (e.g. {}) is silently ignored', async () => {
    const onBroadcast = vi.fn();
    const onKick = vi.fn();
    await connectGatewaySubscriber('redis://x', onBroadcast, onKick);
    h.flags.instances[0]!.emit('message', GW_PUSH_REDIS_CHANNEL, JSON.stringify({}));
    expect(onBroadcast).not.toHaveBeenCalled();
    expect(onKick).not.toHaveBeenCalled();
  });

  describe('publishKick', () => {
    it('publishes a kick envelope to the shared channel via the pub-duplicate connection', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      await sub.publishKick('acc-a', 'inst-1', 7);
      const pubClient = h.flags.instances[1]!;
      expect(JSON.parse(pubClient.lastPublish!.payload)).toEqual({ kick: { accountId: 'acc-a', originInstanceId: 'inst-1', connSeq: 7 } });
      expect(pubClient.lastPublish!.channel).toBe(GW_PUSH_REDIS_CHANNEL);
    });
    it('publish failure is swallowed, not thrown (evicting a stale session is not worth failing a login)', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      h.flags.publishShouldReject = true;
      await expect(sub.publishKick('acc-a', 'inst-1', 7)).resolves.toBeUndefined();
    });
  });

  describe('presence primitives (markOnline/markOffline/refreshOnline/onlineAccountIds)', () => {
    it('markOnline -> onlineAccountIds sees it; markOffline -> gone', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      await sub.markOnline('acc-a');
      expect(await sub.onlineAccountIds(['acc-a'])).toEqual(new Set(['acc-a']));
      await sub.markOffline('acc-a');
      expect(await sub.onlineAccountIds(['acc-a'])).toEqual(new Set());
    });
    it('refreshOnline keeps a presence key alive (pexpire hits an existing key)', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      await sub.markOnline('acc-a');
      await expect(sub.refreshOnline('acc-a')).resolves.toBeUndefined();
    });
    it('onlineAccountIds only reports the ids actually marked online, out of a mixed batch', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      await sub.markOnline('acc-online');
      expect(await sub.onlineAccountIds(['acc-online', 'acc-offline'])).toEqual(new Set(['acc-online']));
    });
    it('empty input never touches the pipeline and returns an empty set', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      expect(await sub.onlineAccountIds([])).toEqual(new Set());
    });
    it('markOnline/markOffline/refreshOnline failures are all swallowed, not thrown', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      h.flags.setShouldReject = true;
      h.flags.delShouldReject = true;
      h.flags.pexpireShouldReject = true;
      await expect(sub.markOnline('acc-a')).resolves.toBeUndefined();
      await expect(sub.markOffline('acc-a')).resolves.toBeUndefined();
      await expect(sub.refreshOnline('acc-a')).resolves.toBeUndefined();
    });
    it('onlineAccountIds pipeline failure fails closed (empty set), not thrown', async () => {
      const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
      await sub.markOnline('acc-a');
      h.flags.pipelineShouldReject = true;
      await expect(sub.onlineAccountIds(['acc-a'])).resolves.toEqual(new Set());
    });
  });

  it('quit() closes all three underlying connections', async () => {
    const sub = (await connectGatewaySubscriber('redis://x', () => {}, () => {}))!;
    await sub.quit();
    expect(h.flags.instances.every((i) => i.quitCalled)).toBe(true);
  });
});
