// WorldApiClient.checkHealth() 单测
// 覆盖：base URL 为空、HTTP 200/503、网络错误、3 秒超时 abort。
// 用假全局 fetch，不触网；通过设置 globalThis.__NW_WORLD_BASE__ 控制 base URL
// （getWorldBaseUrl() 在调用时读取该值，无需 vi.mock）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldApiClient } from '../src/net/WorldApiClient';

// ── Helpers ─────────────────────────────────────────────────────────────────

const noopStorage = {
  getItem: (_k: string): string | null => null,
  setItem: (_k: string, _v: string): void => {},
  removeItem: (_k: string): void => {},
};

function setWorldBase(base: string): void {
  (globalThis as Record<string, unknown>).__NW_WORLD_BASE__ = base;
}

function clearWorldBase(): void {
  delete (globalThis as Record<string, unknown>).__NW_WORLD_BASE__;
}

/** Replace global fetch with a minimal stub. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  (globalThis as Record<string, unknown>).fetch = handler;
}

function stubFetchStatus(status: number): void {
  stubFetch(async () => ({ ok: status >= 200 && status < 300, status }) as Response);
}

afterEach(() => {
  clearWorldBase();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).fetch;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorldApiClient.checkHealth()', () => {
  it('worldBase 为空时直接返回 false，不发请求', async () => {
    setWorldBase('');
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('__NW_WORLD_BASE__ 未设置时同样返回 false', async () => {
    clearWorldBase(); // globalThis 里没有该 key
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('/health 返回 200 → true', async () => {
    setWorldBase('http://localhost:18084');
    stubFetchStatus(200);
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(true);
  });

  it('/health 返回 200 时请求路径正确（base + /health）', async () => {
    setWorldBase('http://localhost:18084');
    let capturedUrl = '';
    stubFetch(async (url) => { capturedUrl = url; return { ok: true, status: 200 } as Response; });
    const client = new WorldApiClient(noopStorage);

    await client.checkHealth();
    expect(capturedUrl).toBe('http://localhost:18084/health');
  });

  it('/health 返回 503 → false', async () => {
    setWorldBase('http://localhost:18084');
    stubFetchStatus(503);
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(false);
  });

  it('/health 返回 404 → false', async () => {
    setWorldBase('http://localhost:18084');
    stubFetchStatus(404);
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(false);
  });

  it('fetch 抛错（连接被拒/网络中断）→ false', async () => {
    setWorldBase('http://localhost:18084');
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(false);
  });

  it('base URL 末尾斜杠被剥除，/health 路径不重复', async () => {
    setWorldBase('http://localhost:18084/'); // 带结尾斜杠
    let capturedUrl = '';
    stubFetch(async (url) => { capturedUrl = url; return { ok: true, status: 200 } as Response; });
    const client = new WorldApiClient(noopStorage);

    await client.checkHealth();
    expect(capturedUrl).toBe('http://localhost:18084/health');
  });

  it('3 秒后 AbortController 取消 fetch → false', async () => {
    setWorldBase('http://localhost:18084');

    // fetch 仅在 signal.abort 后才 reject，模拟 worldsvc 不响应
    stubFetch(async (_url, init) =>
      new Promise<Response>((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new Error('AbortError')));
      }),
    );

    vi.useFakeTimers();
    const client = new WorldApiClient(noopStorage);
    const promise = client.checkHealth();

    // 推进到 3 秒超时点，同时 flush 微任务
    await vi.advanceTimersByTimeAsync(3001);

    expect(await promise).toBe(false);
  });

  it('3 秒内正常响应时不触发 abort，返回 true', async () => {
    setWorldBase('http://localhost:18084');
    let aborted = false;

    stubFetch(async (_url, init) => {
      init.signal!.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200 } as Response;
    });

    vi.useFakeTimers();
    const client = new WorldApiClient(noopStorage);
    const promise = client.checkHealth();

    // 不推进时间 → 正常响应已 resolve，定时器未触发
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe(true);
    expect(aborted).toBe(false);
  });
});
