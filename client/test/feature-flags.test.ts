// Client log targeted collection (FEATURE_FLAGS_DESIGN §9, client side): ring-buffer snapshot + FeatureFlags threshold / batch upload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { netLog, snapshotClientLogs, recordClientLog, LOG_LEVEL_RANK } from '../src/net/log';
import { FeatureFlags } from '../src/net/featureFlags';
import type { ApiClient } from '../src/net/ApiClient';

describe('ring-buffer snapshotClientLogs', () => {
  it('filters by verbosity threshold and returns only entries after afterSeq', () => {
    const lg = netLog('test');
    lg.error('e1');
    lg.warn('w1');
    lg.info('i1');
    lg.debug('d1');
    // error threshold (rank 0): only error level
    const onlyErr = snapshotClientLogs(LOG_LEVEL_RANK.error, 0);
    expect(onlyErr.entries.every((e) => e.level === 'error')).toBe(true);
    expect(onlyErr.entries.some((e) => e.msg === 'e1')).toBe(true);
    // debug threshold (rank 3): all levels
    const all = snapshotClientLogs(LOG_LEVEL_RANK.debug, 0);
    const levels = new Set(all.entries.map((e) => e.level));
    expect(levels.has('error') && levels.has('debug')).toBe(true);
    // afterSeq = current lastSeq → no new entries
    expect(snapshotClientLogs(LOG_LEVEL_RANK.debug, all.lastSeq).entries).toHaveLength(0);
  });

  it('recordClientLog condenses data into msg', () => {
    recordClientLog('info', 'tag', 'hello', { a: 1 });
    const snap = snapshotClientLogs(LOG_LEVEL_RANK.info, 0);
    const last = snap.entries[snap.entries.length - 1];
    expect(last.msg).toContain('hello');
    expect(last.msg).toContain('"a":1');
  });
});

describe('FeatureFlags polling + targeted upload', () => {
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

  it('no client_log_* flag hit → postClientLog not called', async () => {
    const { api } = fakeApi({});
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => '123456789', uploadMs: 1000, pollMs: 5000 });
    ff.start();
    await vi.advanceTimersByTimeAsync(0); // let the initial refresh settle
    recordClientLog('error', 'x', 'boom');
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.postClientLog).not.toHaveBeenCalled();
    ff.stop();
  });

  it('client_log_error flag hit → periodically uploads error-level logs with publicId', async () => {
    const { api, posted } = fakeApi({ client_log_error: true });
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => '123456789', uploadMs: 1000, pollMs: 5000 });
    recordClientLog('error', 'pre', 'context-before'); // context logged before the flag hit should also be captured
    ff.start();
    await vi.advanceTimersByTimeAsync(0); // refresh → flag hit → upload immediately
    expect(api.postClientLog).toHaveBeenCalled();
    expect(posted[0].publicId).toBe('123456789');
    expect(posted[0].logs.length).toBeGreaterThan(0);
    ff.stop();
  });

  it('no publicId → flag hit does not trigger upload (cannot attribute)', async () => {
    const { api } = fakeApi({ client_log_debug: true });
    const ff = new FeatureFlags({ api, platform: 'web', getPublicId: () => null, uploadMs: 1000, pollMs: 5000 });
    recordClientLog('debug', 'x', 'd');
    ff.start();
    await vi.advanceTimersByTimeAsync(0); // let the initial refresh settle
    expect(api.postClientLog).not.toHaveBeenCalled();
    ff.stop();
  });
});
