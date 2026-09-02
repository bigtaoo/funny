/**
 * wechatTransport.test.ts — REST over `wx.request`（ASSET_PACKAGING §4.4 第 1 条 / §4.5）。
 *
 * **harness 与 `wechatHost.test.ts` 同一个范式：小游戏没有的浏览器全局在这里被真的 `delete` 掉，
 * 而不是「碰巧没用到」。** Node 自带 `fetch`，留着它的话，一个仍然落在 `fetch` 上的实现会在这里
 * 全绿、到手机上崩——那正是这一整轮要根治的病（LOG §17.4「从 daydayup 抄到的第三条」）。
 * 所以下面那些 `ApiClient` / `WorldApiClient` 的用例是有分量的：它们跑在一个**没有 fetch 的**
 * 进程里，能跑通就说明那条链路真的不碰 fetch 了。
 *
 * fake 只有 `wx` 一个；它上面的东西全是真的（真 `ApiClient`、真 `rateGate`、真 `AbortController`）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** 小游戏运行时**没有**的浏览器全局。整轮测试期间从 globalThis 上摘掉。 */
const ABSENT = [
  'document', 'window', 'navigator', 'location', 'localStorage',
  'fetch', 'Headers', 'Request', 'Response', 'XMLHttpRequest', 'DOMParser',
] as const;

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

interface WxCall {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: string;
  dataType?: string;
  responseType?: string;
  success?: (res: { data: unknown; statusCode: number }) => void;
  fail?: (err: { errMsg?: string }) => void;
}

let calls: WxCall[];
let aborts: number[];
/** 手动结束第 i 次请求，模拟 wx 的异步回调。 */
function succeed(i: number, statusCode: number, data: unknown): void {
  calls[i]!.success!({ statusCode, data });
}
function failWith(i: number, errMsg: string): void {
  calls[i]!.fail!({ errMsg });
}

let saved: Map<string, { had: boolean; value: unknown }>;

beforeEach(() => {
  saved = new Map();
  for (const key of ABSENT) {
    saved.set(key, { had: key in g, value: g[key] });
    delete g[key];
  }
  calls = [];
  aborts = [];
  vi.stubGlobal('wx', {
    request: vi.fn((opts: WxCall) => {
      const i = calls.push(opts) - 1;
      return { abort: () => aborts.push(i) };
    }),
  });
});

afterEach(() => {
  for (const [key, { had, value }] of saved) {
    if (had) g[key] = value; else delete g[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function transport() {
  const { WechatTransport } = await import('../src/platform/wechat/wechatTransport');
  return new WechatTransport();
}

// ── 前提：这个进程真的没有 fetch ────────────────────────────────────────────
describe('前提：harness 摘掉了 fetch，默认 transport 在这里走不通', () => {
  it('globalThis 上没有 fetch', () => {
    expect('fetch' in g).toBe(false);
  });

  it('默认（web）transport 在这个运行时上只会拒绝 —— 这就是微信的现状', async () => {
    const { fetchTransport } = await import('../src/net/transport');
    await expect(fetchTransport.request({ method: 'GET', url: 'https://h/x', headers: {} })).rejects.toThrow();
  });
});

// ── NetRequest → wx.request 的映射 ─────────────────────────────────────────
describe('映射：NetRequest → wx.request', () => {
  it('POST：url / method / header / data，鉴权头原样带上', async () => {
    const t = await transport();
    const p = t.request({
      method: 'POST',
      url: 'https://h/api/auth/login',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: '{"loginId":"bob"}',
    });
    succeed(0, 200, '{"ok":true,"data":1}');
    await p;

    expect(calls[0]!.url).toBe('https://h/api/auth/login');
    expect(calls[0]!.method).toBe('POST');
    // 字段名是 `header`，不是 `headers` —— 写错的话请求照发，只是一个头都不带（鉴权全线失效）。
    expect(calls[0]!.header).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' });
    expect(calls[0]!.data).toBe('{"loginId":"bob"}');
  });

  it('GET 无 body：`data` 键根本不出现（present-but-undefined 会被 wx 当成空体）', async () => {
    const t = await transport();
    const p = t.request({ method: 'GET', url: 'https://h/health', headers: {} });
    succeed(0, 200, '{}');
    await p;
    expect('data' in calls[0]!).toBe(false);
  });

  it('dataType 必须不是 `json` —— 不许让 wx 替我们 parse', async () => {
    // wx 的默认值 'json' 会替我们 JSON.parse，而**失败时静默把字符串原样给回来**：于是一次
    // 502 的 HTML 错误页会变成 `json.ok === undefined`，被 ApiClientCore 当成……什么都不是。
    const t = await transport();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {} });
    succeed(0, 200, '{}');
    await p;
    expect(calls[0]!.dataType).toBeDefined();
    expect(calls[0]!.dataType).not.toBe('json');
  });

  it('credentials 不映射任何东西 —— 小游戏没有 cookie jar，`omit` 天然成立', async () => {
    const t = await transport();
    const p = t.request({ method: 'POST', url: 'https://h/x', headers: {}, body: '{}', credentials: 'omit', keepalive: true });
    succeed(0, 200, '{}');
    await p;
    expect(Object.keys(calls[0]!)).not.toContain('credentials');
    expect(Object.keys(calls[0]!)).not.toContain('keepalive');
  });
});

// ── NetResponse 的形状 ─────────────────────────────────────────────────────
describe('Response 形状：ok / status / json() / text()', () => {
  it('2xx → ok，json() 解析出对象，text() 给回原串', async () => {
    const t = await transport();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {} });
    succeed(0, 200, '{"ok":true,"data":{"n":1}}');
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { n: 1 } });
    expect(await res.text()).toBe('{"ok":true,"data":{"n":1}}');
  });

  it('4xx → ok 为 false，但信封仍然读得出来（ApiClientCore 就是从这里取 error.code 的）', async () => {
    const t = await transport();
    const p = t.request({ method: 'POST', url: 'https://h/x', headers: {} });
    succeed(0, 403, '{"ok":false,"error":{"code":"BANNED","message":"nope"}}');
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'BANNED' } });
  });

  it('非法 JSON → json() 抛，与 Response.json() 一致（不静默返回字符串）', async () => {
    const t = await transport();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {} });
    succeed(0, 502, '<html>Bad Gateway</html>');
    const res = await p;
    expect(res.ok).toBe(false);
    await expect(res.json()).rejects.toThrow();
    expect(await res.text()).toBe('<html>Bad Gateway</html>');
  });

  it('宿主自作主张已经 parse 成对象时也一样（`declare` 两个方向都不是证据）', async () => {
    const t = await transport();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {} });
    succeed(0, 200, { ok: true, data: 7 });
    const res = await p;
    expect(await res.json()).toEqual({ ok: true, data: 7 });
    expect(await res.text()).toBe('{"ok":true,"data":7}');
  });
});

// ── AbortSignal ↔ RequestTask.abort() ─────────────────────────────────────
describe('取消：AbortSignal ↔ RequestTask.abort()', () => {
  it('signal 已经 aborted → 直接拒绝，一个包都不发', async () => {
    const t = await transport();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(t.request({ method: 'GET', url: 'https://h/x', headers: {}, signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('中途 abort → 以 AbortError 拒绝，且 task.abort() 被调用', async () => {
    const t = await transport();
    const ctrl = new AbortController();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {}, signal: ctrl.signal });
    expect(calls).toHaveLength(1);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborts).toEqual([0]);
  });

  it('abort 之后 wx 才回调 fail —— 不产生第二次 settle（未处理的拒绝会污染整个 suite）', async () => {
    const t = await transport();
    const ctrl = new AbortController();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {}, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => failWith(0, 'request:fail abort')).not.toThrow();
    expect(() => succeed(0, 200, '{}')).not.toThrow();
  });

  it('请求先完成，之后 abort（超时定时器晚到）不再动 task', async () => {
    const t = await transport();
    const ctrl = new AbortController();
    const p = t.request({ method: 'GET', url: 'https://h/x', headers: {}, signal: ctrl.signal });
    succeed(0, 200, '{}');
    await p;
    ctrl.abort();
    expect(aborts).toEqual([]);
  });
});

describe('网络失败', () => {
  it('wx 的 fail 变成一次拒绝，错误里能看见是哪个请求', async () => {
    const t = await transport();
    const p = t.request({ method: 'POST', url: 'https://h/api/save', headers: {} });
    failWith(0, 'request:fail -102:net::ERR_CONNECTION_REFUSED');
    await expect(p).rejects.toThrow(/https:\/\/h\/api\/save.*ERR_CONNECTION_REFUSED/s);
  });
});

// ── 端到端：真 ApiClient 跑在没有 fetch 的进程里 ────────────────────────────
describe('端到端：ApiClient over wx.request（进程里没有 fetch）', () => {
  async function install() {
    const { setNetTransport, fetchTransport } = await import('../src/net/transport');
    setNetTransport(await transport());
    return () => setNetTransport(fetchTransport);
  }

  it('login 成功：带 authorization/x-nw-platform 头，信封解开后返回 data', async () => {
    const restore = await install();
    const { ApiClient } = await import('../src/net/ApiClient');
    const api = new ApiClient('https://h/api');
    api.setToken('tok-0');

    const p = api.login('bob', 'secret123');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.header!['authorization']).toBe('Bearer tok-0');
    expect(calls[0]!.header!['x-nw-platform']).toBe('web'); // TARGET 未注入 → 'web'（构建期决定，与 transport 无关）
    succeed(0, 200, JSON.stringify({ ok: true, data: { token: 'tok-1', accountId: 'acc-1', isNew: false, isAnonymous: false } }));

    expect((await p).accountId).toBe('acc-1');
    restore();
  });

  it('服务端错误信封 → ApiError（错误码没有在 wx 那一层丢掉）', async () => {
    const restore = await install();
    const { ApiClient, ApiError } = await import('../src/net/ApiClient');
    const p = new ApiClient('https://h/api').login('bob', 'secret123').catch((e: unknown) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    succeed(0, 401, JSON.stringify({ ok: false, error: { code: 'BAD_CREDENTIALS', message: 'no' } }));
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('BAD_CREDENTIALS');
    restore();
  });

  it('ADR-058 的 10s 超时照样生效：定时器一到就 task.abort()，promise 以拒绝收场', async () => {
    // 与 api-client-timeout.test.ts 是同一条契约，只是换了运行时。超时的**唯一来源**仍然是
    // fetchRaw 里那个 AbortController + setTimeout；transport 只负责把 signal 接到 RequestTask 上。
    const restore = await install();
    const { ApiClient } = await import('../src/net/ApiClient');
    vi.useFakeTimers();
    const result = new ApiClient('https://h/api').login('bob', 'secret123').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborts).toEqual([]); // 还没到点

    await vi.advanceTimersByTimeAsync(2);
    expect(aborts).toEqual([0]);
    expect(await result).toBeInstanceOf(Error);
    restore();
  });
});
