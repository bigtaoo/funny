// connectRedis() unit tests (previously 0% coverage). Mocks the `ioredis` module (dynamically imported
// by src/redis.ts with a variable specifier so tsc can compile without ioredis installed) with an
// in-memory fake emitter, so this suite runs everywhere with no real Redis. Exercises: no-url short
// circuit, successful ready handshake (+ every WorldRedis method forwarding, including hmergeJsonField's
// null->'' entryJson coercion), the error-event path, the plain-timeout path (neither ready nor error),
// and a synchronous constructor throw.
//
// Timing note: connectRedis() awaits a dynamic `import('ioredis')` before doing anything observable, and
// that resolution is not synchronous under Vitest's module runner (nor deterministic in how many
// microtask ticks it takes, especially the very first call in the process and/or under coverage
// instrumentation) — polling for "has the mock instance been constructed yet" after a fixed number of
// ticks proved flaky. Instead, FakeRedis auto-emits its 'ready'/'error' event itself (via
// process.nextTick, from inside its own constructor) when configured to, so the tests simply `await`
// connectRedis()'s returned promise directly instead of racing to grab the instance mid-flight.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  class SimpleEmitter {
    private handlers: Record<string, Array<(...a: any[]) => void>> = {};
    on(event: string, fn: (...a: any[]) => void): this {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    once(event: string, fn: (...a: any[]) => void): this {
      const wrapper = (...args: any[]) => {
        this.off(event, wrapper);
        fn(...args);
      };
      this.on(event, wrapper);
      return this;
    }
    off(event: string, fn: (...a: any[]) => void): this {
      this.handlers[event] = (this.handlers[event] ?? []).filter((f) => f !== fn);
      return this;
    }
    emit(event: string, ...args: any[]): void {
      for (const fn of (this.handlers[event] ?? []).slice()) fn(...args);
    }
  }

  class FakeRedis extends SimpleEmitter {
    url: string;
    opts: unknown;
    disconnectCalled = false;
    evalCalls: Array<{ script: string; numKeys: number; args: unknown[] }> = [];
    constructor(url: string, opts: unknown) {
      super();
      if (flags.throwOnConstruct) throw new Error('construct failed');
      this.url = url;
      this.opts = opts;
      flags.instances.push(this);
      // Auto-emit deterministically shortly after construction (real ioredis behaves async too) instead
      // of relying on the test to catch the instance mid-flight and emit manually.
      if (flags.autoEmit === 'ready') process.nextTick(() => this.emit('ready'));
      else if (flags.autoEmit === 'error') process.nextTick(() => this.emit('error', new Error('boom')));
      // 'none' -> never emits; connectRedis's own INITIAL_CONNECT_TIMEOUT_MS setTimeout is what settles it.
    }
    disconnect(): void {
      this.disconnectCalled = true;
    }
    async publish(channel: string, message: string): Promise<unknown> {
      return ['publish', channel, message];
    }
    async hset(key: string, field: string, value: string): Promise<unknown> {
      return ['hset', key, field, value];
    }
    async hget(key: string, field: string): Promise<string> {
      return `val:${key}:${field}`;
    }
    async hdel(key: string, ...fields: string[]): Promise<unknown> {
      return ['hdel', key, ...fields];
    }
    async quit(): Promise<string> {
      return 'OK';
    }
    async del(key: string): Promise<unknown> {
      return ['del', key];
    }
    async eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown> {
      this.evalCalls.push({ script, numKeys, args });
      return 1;
    }
  }

  const flags: { instances: FakeRedis[]; throwOnConstruct: boolean; autoEmit: 'ready' | 'error' | 'none' } = {
    instances: [],
    throwOnConstruct: false,
    autoEmit: 'none',
  };
  return { FakeRedis, flags };
});

vi.mock('ioredis', () => ({ default: h.FakeRedis }));

// Imported after the mock is registered (vi.mock calls are hoisted above this anyway).
const { connectRedis } = await import('../src/redis');

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.flags.instances.length = 0;
  h.flags.throwOnConstruct = false;
  h.flags.autoEmit = 'none';
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe('connectRedis', () => {
  it('url undefined -> returns null without ever constructing ioredis', async () => {
    const r = await connectRedis(undefined);
    expect(r).toBeNull();
    expect(h.flags.instances).toHaveLength(0);
  });

  it('ready event -> wraps client, forwarding every WorldRedis method to the underlying client', async () => {
    h.flags.autoEmit = 'ready';
    const wrapped = await connectRedis('redis://x');
    expect(wrapped).not.toBeNull();
    expect(h.flags.instances).toHaveLength(1);
    const client = h.flags.instances[0]!;

    await expect(wrapped!.publish('ch', 'msg')).resolves.toEqual(['publish', 'ch', 'msg']);
    await expect(wrapped!.hset('k', 'f', 'v')).resolves.toEqual(['hset', 'k', 'f', 'v']);
    await expect(wrapped!.hget('k', 'f')).resolves.toBe('val:k:f');
    await expect(wrapped!.hdel('k', 'f1', 'f2')).resolves.toEqual(['hdel', 'k', 'f1', 'f2']);
    await expect(wrapped!.del!('k')).resolves.toEqual(['del', 'k']);
    await expect(wrapped!.quit()).resolves.toBe('OK');

    await wrapped!.hmergeJsonField!('k', 'f', 'entry-1', '{"a":1}');
    expect(client.evalCalls[0]).toEqual({
      script: expect.stringContaining('HGET'),
      numKeys: 1,
      args: ['k', 'f', 'entry-1', '{"a":1}'],
    });

    // entryJson null -> forwarded as '' (removal sentinel understood by the Lua script).
    await wrapped!.hmergeJsonField!('k', 'f', 'entry-1', null);
    expect(client.evalCalls[1]!.args).toEqual(['k', 'f', 'entry-1', '']);
  });

  it('error event -> resolves null, disconnects the client, logs both the error and the not-ready message', async () => {
    h.flags.autoEmit = 'error';
    const wrapped = await connectRedis('redis://x');
    expect(wrapped).toBeNull();
    expect(h.flags.instances).toHaveLength(1);
    const client = h.flags.instances[0]!;
    expect(client.disconnectCalled).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('[world-redis] error:', 'boom');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not ready within'));
  });

  it('neither ready nor error fires -> times out after INITIAL_CONNECT_TIMEOUT_MS, resolves null + disconnects', async () => {
    vi.useFakeTimers();
    const p = connectRedis('redis://x');
    let settled: unknown;
    let isSettled = false;
    void p.then((v) => {
      settled = v;
      isSettled = true;
    });

    // The dynamic import's resolution timing (and thus exactly when the internal 5s timer gets armed) is
    // not deterministic under fake timers, so advance repeatedly in small steps — each
    // advanceTimersByTimeAsync call also flushes pending microtasks, letting the import settle and the
    // timer get armed partway through this loop — until the promise has actually settled.
    for (let i = 0; i < 30 && !isSettled; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(isSettled).toBe(true);
    expect(settled).toBeNull();
    expect(h.flags.instances).toHaveLength(1);
    expect(h.flags.instances[0]!.disconnectCalled).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not ready within 5000ms'));
  });

  it('synchronous constructor throw -> outer catch returns null with a distinct "Failed to connect" log', async () => {
    h.flags.throwOnConstruct = true;
    const wrapped = await connectRedis('redis://x');
    expect(wrapped).toBeNull();
    expect(h.flags.instances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to connect to Redis'));
  });
});
