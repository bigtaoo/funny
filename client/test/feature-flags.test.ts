// 客户端日志定向采集（FEATURE_FLAGS_DESIGN §9，客户端侧）：环形缓冲 snapshot + FeatureFlags 阈值/批量上报。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { netLog, snapshotClientLogs, recordClientLog, LOG_LEVEL_RANK } from '../src/net/log';
import { FeatureFlags } from '../src/net/featureFlags';
import type { ApiClient } from '../src/net/ApiClient';

describe('环形缓冲 snapshotClientLogs', () => {
  it('按阈值 verbose 度过滤 + 只取 afterSeq 之后的新条目', () => {
    const lg = netLog('test');
    lg.error('e1');
    lg.warn('w1');
    lg.info('i1');
    lg.debug('d1');
    // error 阈值（rank 0）：仅 error 级
    const onlyErr = snapshotClientLogs(LOG_LEVEL_RANK.error, 0);
    expect(onlyErr.entries.every((e) => e.level === 'error')).toBe(true);
    expect(onlyErr.entries.some((e) => e.msg === 'e1')).toBe(true);
    // debug 阈值（rank 3）：全部级别
    const all = snapshotClientLogs(LOG_LEVEL_RANK.debug, 0);
    const levels = new Set(all.entries.map((e) => e.level));
    expect(levels.has('error') && levels.has('debug')).toBe(true);
    // afterSeq = 当前 lastSeq → 无新条目
    expect(snapshotClientLogs(LOG_LEVEL_RANK.debug, all.lastSeq).entries).toHaveLength(0);
  });

  it('recordClientLog 把 data 浓缩进 msg', () => {
    recordClientLog('info', 'tag', 'hello', { a: 1 });
    const snap = snapshotClientLogs(LOG_LEVEL_RANK.info, 0);
    const last = snap.entries[snap.entries.length - 1];
    expect(last.msg).toContain('hello');
    expect(last.msg).toContain('"a":1');
  });
});

describe('FeatureFlags 轮询 + 定向上报', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function fakeApi(flags: Record<string, boolean>) {
    const posted: { publicId: string; logs: unknown[] }[] = [];
    const api = {
      getBootstrap: vi.fn(async () => ({ flags })),
      postClientLog: vi.fn(async (body: { publicId: string; logs: unknown[] }) => { posted.push(body); }),
    } as unknown as ApiClient;
    return { api, posted };
  }

  it('未命中 client_log_* → 不调 postClientLog', async () => {
    const { api } = fakeApi({});
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => '123456789', uploadMs: 1000, pollMs: 5000 });
    ff.start();
    await vi.advanceTimersByTimeAsync(0); // 让首拉 refresh 落地
    recordClientLog('error', 'x', 'boom');
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.postClientLog).not.toHaveBeenCalled();
    ff.stop();
  });

  it('命中 client_log_error → 周期上报 error 级日志，带 publicId', async () => {
    const { api, posted } = fakeApi({ client_log_error: true });
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => '123456789', uploadMs: 1000, pollMs: 5000 });
    recordClientLog('error', 'pre', 'context-before'); // 命中前的上下文也应被捞到
    ff.start();
    await vi.advanceTimersByTimeAsync(0); // refresh → 命中 → 立即上报一次
    expect(api.postClientLog).toHaveBeenCalled();
    expect(posted[0].publicId).toBe('123456789');
    expect(posted[0].logs.length).toBeGreaterThan(0);
    ff.stop();
  });

  it('无 publicId → 命中也不上报（无法归属）', async () => {
    const { api } = fakeApi({ client_log_debug: true });
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => null, uploadMs: 1000, pollMs: 5000 });
    recordClientLog('debug', 'x', 'd');
    ff.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.postClientLog).not.toHaveBeenCalled();
    ff.stop();
  });
});
