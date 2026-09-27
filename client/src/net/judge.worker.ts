// Web Worker entry for peer-judge recomputes (see judgeExecutor.ts / platform/web/workerJudge.ts).
// Browsers expose no thread priority, so "low priority" is done by hand: jobs run one at a time and
// the engine sleeps between short slices, leaving most of a core to the page (and the player's own
// match) even on a device with few cores.

import type { JudgeRequest } from './proto/transport';
import { runJudgeSliced } from './judgeRunner';
import { JUDGE_DEADLINE_MS, JudgeDeadlineError, sleep } from './judgeExecutor';

export interface JudgeWorkerRequest {
  id: number;
  req: JudgeRequest;
}

const WORKER_SLICE_TICKS = 60;
const WORKER_PAUSE_MS = 8;

const scope = globalThis as unknown as {
  onmessage: ((e: { data: JudgeWorkerRequest }) => void) | null;
  postMessage(msg: unknown): void;
};

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const { id, req } = e.data;
  // The deadline counts from arrival, not from when the queue reaches this job.
  const deadline = Date.now() + JUDGE_DEADLINE_MS;
  queue = queue.then(async () => {
    const out = await runJudgeSliced(
      req,
      async () => {
        if (Date.now() > deadline) throw new JudgeDeadlineError();
        await sleep(WORKER_PAUSE_MS);
      },
      WORKER_SLICE_TICKS,
    );
    scope.postMessage({ id, out });
  });
};
