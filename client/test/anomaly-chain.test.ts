// 客户端异常上报「全链路」测试（FEATURE_FLAGS_DESIGN §9.7）。
//
// 链路：客户端 net/anomaly.ts(AnomalyReporter / 崩溃哨兵 / 离场 beacon)
//        --POST /client/anomaly--> 服务端 clientAnomaly handler
//        --buildAnomalyLokiPayload--> Loki push 行。
//
// 服务端 handler 那半条（校验/IP 限流/anon 兜底/转发）已由
// server/metaserver/test/clientLog.test.ts 覆盖；本测试补**客户端那半条**（此前零覆盖，
// 且是 2026-06-27 两处 bug 的修复点），并把客户端真实发出的 body 喂进服务端**真实的**
// Loki 格式化函数 buildAnomalyLokiPayload，断言最终 Loki 行——即「客户端事件 → Loki 行」全链路。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 全链路接缝：服务端把收到的 events 转 Loki 行就靠这个纯函数（无依赖，可跨包直接 import）。
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
 * 每个用例都重置模块再 import：anomaly.ts 的 AnomalyReporter / 崩溃哨兵 / installAnomalyWatchers
 * 都是模块级单例 + 一次性安装闸（__nwAnomalyHooked），不隔离会串味。globals 用 vi.stubGlobal
 * 注入（node 自带的 navigator 是只读的，直接赋值会抛）。
 */
async function freshAnomaly(opts: { base?: string; publicId?: string | null } = {}): Promise<{
  mod: typeof import('../src/net/anomaly');
  cap: Captured;
}> {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__nwAnomalyHooked; // 解除一次性安装闸

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

  const cap: Captured = {
    fetch: fetchMock,
    sendBeacon,
    store,
    doc,
    fire: (type, ev) => (listeners.get(type) ?? []).forEach((f) => f(ev)),
  };
  const mod = await import('../src/net/anomaly');
  return { mod, cap };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 客户端 → POST /client/anomaly（普通合批 fetch 通道）───────────────────────────
describe('AnomalyReporter.report → 合批 POST', () => {
  beforeEach(() => vi.useFakeTimers());

  it('1.5s 合批后 POST 到 /client/anomaly，body 形状正确（publicId/platform/events）', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.reportAnomaly('webgl_lost', 'context lost', { glError: 1282 });
    expect(cap.fetch).not.toHaveBeenCalled(); // 合批延迟内不发
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
    expect(body.events[0].detail).toContain('1282'); // detail 压成串
  });

  it('同类型在冷却窗口内的二次上报被丢（mem 60s 合一）', async () => {
    const { mod, cap } = await freshAnomaly();
    mod.reportAnomaly('mem', 'heap 1');
    mod.reportAnomaly('mem', 'heap 2'); // 冷却内 → 丢
    await vi.advanceTimersByTimeAsync(1500);
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].msg).toBe('heap 1');
  });

  it('无 baseUrl → 不发包（静默丢弃，绝不影响玩家）', async () => {
    const { mod, cap } = await freshAnomaly({ base: '' });
    mod.reportAnomaly('jserror', 'boom');
    await vi.advanceTimersByTimeAsync(1500);
    expect(cap.fetch).not.toHaveBeenCalled();
  });
});

// ── 全链路接缝：客户端 body → 服务端 Loki 格式化 → Loki 行 ──────────────────────────
describe('全链路：客户端 POST 的 events 经服务端 buildAnomalyLokiPayload → Loki 行', () => {
  beforeEach(() => vi.useFakeTimers());

  it('客户端发出的 event 在服务端转成 {source,kind=anomaly} 单 stream + logfmt 行', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.reportAnomaly('crash', 'previous session ended without clean exit', { aliveMs: 4200 });
    await vi.advanceTimersByTimeAsync(1500);

    // 取客户端真实发出的 body，喂进服务端真实的 Loki 格式化函数（= handler 内部所做）。
    const body = JSON.parse((cap.fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const payload = buildAnomalyLokiPayload(body.publicId, body.events, body.platform, () => '0')!;

    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0].stream).toEqual({ source: 'client', kind: 'anomaly' });
    const line = payload.streams[0].values[0][1];
    expect(line).toContain('type=crash');
    expect(line).toContain(`publicId=${PUBLIC_ID}`);
    expect(line).toContain('platform=web');
    expect(line).toContain('detail=');
    expect(line).toContain('msg="previous session ended without clean exit"'); // 含空格 → logfmt 引号
  });
});

// ── 离场捕获（回归：2026-06-27 Bug A —— hidden 不标 cleanExit）────────────────────────
describe('离场 beacon 与 cleanExit 标记（Bug A 回归）', () => {
  beforeEach(() => vi.useFakeTimers());

  it('visibilitychange→hidden：beacon 抢发队列，但**不**标 cleanExit', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.initCrashSentinel();          // 开本次会话哨兵（cleanExit 未设）
    mod.installAnomalyWatchers();     // 装离场监听
    mod.reportAnomaly('anr', 'stall'); // 队列里塞一条，离场才有东西抢发

    cap.doc.visibilityState = 'hidden';
    cap.fire('visibilitychange');

    expect(cap.sendBeacon).toHaveBeenCalledTimes(1); // 抢发了
    const sentinel = JSON.parse(cap.store.get(SENTINEL)!);
    expect(sentinel.cleanExit).toBeUndefined(); // 关键：hidden 不算干净退出（iOS 后台可能被杀）
  });

  it('pagehide：既抢发又标 cleanExit（真·卸载）', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    mod.initCrashSentinel();
    mod.installAnomalyWatchers();
    mod.reportAnomaly('anr', 'stall');

    cap.fire('pagehide');

    expect(cap.sendBeacon).toHaveBeenCalledTimes(1);
    const sentinel = JSON.parse(cap.store.get(SENTINEL)!);
    expect(sentinel.cleanExit).toBe(true);
  });

  it('上次哨兵带 cleanExit → 下次启动不补报 crash（无 beacon）', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    cap.store.set(SENTINEL, JSON.stringify({ startedAt: 1000, lastSeenAt: 5000, cleanExit: true }));
    mod.initCrashSentinel();
    expect(cap.sendBeacon).not.toHaveBeenCalled();
  });
});

// ── 崩溃哨兵补报（回归：2026-06-27 Bug B —— 立即 beacon，不等 1.5s 合批）────────────────
describe('崩溃哨兵补报立即 beacon（Bug B 回归）', () => {
  beforeEach(() => vi.useFakeTimers());

  it('启动检测到上次未干净退出 → 当场 beacon 发出 crash（无需推进 1.5s 合批定时器）', async () => {
    const { mod, cap } = await freshAnomaly({ publicId: PUBLIC_ID });
    // 预置一条「上次会话异常退出」哨兵（有 startedAt、无 cleanExit）。
    cap.store.set(
      SENTINEL,
      JSON.stringify({ startedAt: 1000, lastSeenAt: 5000, lastError: 'TypeError x' }),
    );

    mod.initCrashSentinel();

    // 关键：还没 advanceTimers，beacon 就该已发（否则成串崩溃时永远发不出）。
    expect(cap.sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = cap.sendBeacon.mock.calls[0] as [string, Blob];
    expect(url).toBe(ANOMALY_URL);
    const sent = JSON.parse(await blob.text());
    expect(sent.events.some((e: { type: string }) => e.type === 'crash')).toBe(true);
    expect(cap.fetch).not.toHaveBeenCalled(); // 走的是 beacon，不是合批 fetch
  });
});
