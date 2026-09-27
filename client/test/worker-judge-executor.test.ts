// Main-thread side of the Web Worker judge executor (platform/web/workerJudge.ts): one long-lived
// worker, replies matched to their requests by id, and a crash fails every pending recompute
// (meta voids those spot-checks) instead of leaving them hanging until the gateway times out.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerJudgeExecutor } from '../src/platform/web/workerJudge';
import type { JudgeWorkerRequest } from '../src/net/judge.worker';
import type { JudgeRequest } from '../src/net/proto/transport';
import type { JudgeOutcome } from '../src/net/judgeRunner';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: { id: number; out: JudgeOutcome } }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  posted: JudgeWorkerRequest[] = [];
  terminated = false;
  constructor(readonly url: URL) { FakeWorker.instances.push(this); }
  postMessage(msg: JudgeWorkerRequest): void { this.posted.push(msg); }
  terminate(): void { this.terminated = true; }
  reply(id: number, out: JudgeOutcome): void { this.onmessage!({ data: { id, out } }); }
  crash(): void { this.onerror!({ message: 'boom' }); }
}

const req = (id: string): JudgeRequest => ({ requestId: id }) as JudgeRequest;
const outcome = (hash: string): JudgeOutcome => ({ ok: true, stateHash: hash, winnerSide: 1, stars: 0, statsJson: '' });
const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' };

describe('createWorkerJudgeExecutor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances = [];
  });

  it('returns null when the runtime has no Worker (WeChat keeps the main-thread executor)', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createWorkerJudgeExecutor()).toBeNull();
  });

  it('spawns the worker lazily, reuses it, and routes out-of-order replies by id', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const exec = createWorkerJudgeExecutor()!;
    expect(FakeWorker.instances).toHaveLength(0);

    const a = exec(req('a'));
    const b = exec(req('b'));
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0]!;
    expect(w.url.pathname).toMatch(/judge\.worker\.ts$/);
    expect(w.posted.map((m) => m.req.requestId)).toEqual(['a', 'b']);

    const [idA, idB] = w.posted.map((m) => m.id);
    w.reply(idB!, outcome('hb'));
    w.reply(idA!, outcome('ha'));
    await expect(a).resolves.toEqual(outcome('ha'));
    await expect(b).resolves.toEqual(outcome('hb'));
  });

  it('a crash fails every pending recompute, and the next request gets a fresh worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const exec = createWorkerJudgeExecutor()!;
    const a = exec(req('a'));
    const b = exec(req('b'));
    const first = FakeWorker.instances[0]!;
    first.crash();
    await expect(a).resolves.toEqual(FAIL);
    await expect(b).resolves.toEqual(FAIL);
    expect(first.terminated).toBe(true);

    const c = exec(req('c'));
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1]!;
    second.reply(second.posted[0]!.id, outcome('hc'));
    await expect(c).resolves.toEqual(outcome('hc'));
  });

  it('a Worker that cannot be constructed fails the recompute instead of throwing', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked by CSP'); } });
    const exec = createWorkerJudgeExecutor()!;
    await expect(exec(req('a'))).resolves.toEqual(FAIL);
  });
});
