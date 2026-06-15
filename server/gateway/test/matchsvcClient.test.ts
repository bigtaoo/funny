// MatchsvcClient 单测（S1-M5）：gateway → matchsvc 内部 HTTP 客户端把各控制命令 POST 到
// 正确端点、带正确 body 与 X-Internal-Key；无 baseUrl 时不发请求（available=false）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MatchsvcClient } from '../src/matchsvcClient';

const KEY = 'test-internal-key';
const BASE = 'http://matchsvc:8091';

interface Call {
  url: string;
  body: Record<string, unknown>;
  key: string | undefined;
}

function install(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      key: headers['X-Internal-Key'],
    });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return calls;
}

describe('MatchsvcClient', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = install();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('各命令打到对应端点，带 body 与内部密钥', () => {
    const c = new MatchsvcClient(BASE, KEY);
    c.roomCreate('a', 'Alice', '100000001');
    c.roomJoin('b', 'Bob', '100000002', 'ABC123');
    c.roomReady('a', true);
    c.roomStart('a');
    c.roomLeave('b');
    c.enqueue('a', 'Alice', '100000001', 1234);
    c.connected('a');
    c.disconnected('b');

    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/mm/room/create`,
      `${BASE}/mm/room/join`,
      `${BASE}/mm/room/ready`,
      `${BASE}/mm/room/start`,
      `${BASE}/mm/room/leave`,
      `${BASE}/mm/queue/enqueue`,
      `${BASE}/mm/conn/connected`,
      `${BASE}/mm/conn/disconnected`,
    ]);
    expect(calls.every((x) => x.key === KEY)).toBe(true);
    expect(calls[1]!.body).toEqual({ accountId: 'b', name: 'Bob', publicId: '100000002', code: 'ABC123' });
    expect(calls[5]!.body).toEqual({ accountId: 'a', name: 'Alice', publicId: '100000001', elo: 1234 });
  });

  it('无 baseUrl → available=false 且不发请求', () => {
    const c = new MatchsvcClient(null, KEY);
    expect(c.available).toBe(false);
    c.roomCreate('a', 'A', '100000001');
    expect(calls).toHaveLength(0);
  });
});
