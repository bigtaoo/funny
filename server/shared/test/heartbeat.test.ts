// Unit tests for heartbeat.ts's startHeartbeat(): fires once immediately, then on the interval; default
// vs custom msg; opts.extra() merged in (and its failure swallowed without affecting the heartbeat);
// stop() halts further firing. Uses vi.useFakeTimers() throughout; log is a mock Logger.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHeartbeat } from '../src/heartbeat';
import type { Logger } from '../src/logger';

function makeMockLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once immediately on startup with the default msg', () => {
    const log = makeMockLog();
    startHeartbeat(log);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('heartbeat', expect.objectContaining({ uptimeSec: expect.any(Number), rssMb: expect.any(Number) }));
  });

  it('uses a custom msg when provided', () => {
    const log = makeMockLog();
    startHeartbeat(log, { msg: 'custom-beat' });
    expect(log.info).toHaveBeenCalledWith('custom-beat', expect.any(Object));
  });

  it('fires again after intervalMs elapses, and repeatedly thereafter', () => {
    const log = makeMockLog();
    startHeartbeat(log, { intervalMs: 1000 });
    expect(log.info).toHaveBeenCalledTimes(1); // immediate fire
    vi.advanceTimersByTime(1000);
    expect(log.info).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(log.info).toHaveBeenCalledTimes(3);
  });

  it('defaults intervalMs to 5 minutes', () => {
    const log = makeMockLog();
    startHeartbeat(log);
    expect(log.info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(log.info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it('merges opts.extra() into the logged data', () => {
    const log = makeMockLog();
    startHeartbeat(log, { extra: () => ({ activeConns: 42 }) });
    expect(log.info).toHaveBeenCalledWith('heartbeat', expect.objectContaining({ activeConns: 42 }));
  });

  it('opts.extra() throwing does not prevent the heartbeat log itself (caught and ignored)', () => {
    const log = makeMockLog();
    startHeartbeat(log, {
      extra: () => {
        throw new Error('extra failed');
      },
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    const [, data] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(data).not.toHaveProperty('activeConns');
  });

  it('stop() halts further firing', () => {
    const log = makeMockLog();
    const handle = startHeartbeat(log, { intervalMs: 1000 });
    expect(log.info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(log.info).toHaveBeenCalledTimes(2);
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(log.info).toHaveBeenCalledTimes(2); // no further calls after stop
  });
});
