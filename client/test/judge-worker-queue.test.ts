// Inside the judge Web Worker (net/judge.worker.ts): recomputes run strictly one at a time, and each
// job's deadline counts from when it arrived — a job that waited behind a long one must give up at
// 19 s after arrival (the gateway has stopped waiting at 20 s), not get a fresh 19 s once it starts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeRequest } from '../src/net/proto/transport';
import type { JudgeOutcome } from '../src/net/judgeRunner';

// Stand-in for the engine: a job of N slices calls pause() N times (each pause is one 8 ms sleep),
// and a pause that throws ends the run with ok:false — the same contract runJudgeSliced keeps.
const log: string[] = [];
const SLICES: Record<string, number> = {};
vi.mock('../src/net/judgeRunner', () => ({
  runJudgeSliced: async (req: JudgeRequest, pause: () => Promise<void>): Promise<JudgeOutcome> => {
    log.push(`start ${req.requestId}`);
    try {
      for (let i = 0; i < SLICES[req.requestId]!; i++) await pause();
    } catch {
      log.push(`gave up ${req.requestId}`);
      return { ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' };
    }
    log.push(`end ${req.requestId}`);
    return { ok: true, stateHash: req.requestId, winnerSide: 1, stars: 0, statsJson: '' };
  },
}));

type Scope = { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
const scope = globalThis as unknown as Scope;

describe('judge worker queue', () => {
  let posted: { id: number; out: JudgeOutcome }[];

  beforeEach(async () => {
    vi.useFakeTimers();
    log.length = 0;
    posted = [];
    scope.postMessage = (m) => { posted.push(m as { id: number; out: JudgeOutcome }); };
    vi.resetModules();
    await import('../src/net/judge.worker');
  });

  afterEach(() => {
    vi.useRealTimers();
    scope.onmessage = null;
  });

  const send = (id: number, requestId: string, slices: number): void => {
    SLICES[requestId] = slices;
    scope.onmessage!({ data: { id, req: { requestId } } });
  };

  it('runs jobs one at a time, in arrival order', async () => {
    send(1, 'a', 10);
    send(2, 'b', 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(posted.map((p) => [p.id, p.out.stateHash])).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('a job queued behind a long one keeps its arrival deadline', async () => {
    // a: 2000 slices × 8 ms = 16 s, inside its own deadline. b arrives at t=0 and needs another
    // 8 s, which would fit in a fresh 19 s window but not in the 3 s that remain of its own.
    send(1, 'a', 2_000);
    send(2, 'b', 1_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toEqual(['start a', 'end a', 'start b', 'gave up b']);
    expect(posted.map((p) => [p.id, p.out.ok])).toEqual([[1, true], [2, false]]);
  });

  it('a single job past 19 s gives up', async () => {
    send(1, 'a', 3_000); // 24 s of slices
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toEqual(['start a', 'gave up a']);
    expect(posted[0]!.out.ok).toBe(false);
  });
});
