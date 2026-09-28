// Where a peer-judge recompute runs (PEER_JUDGE: background priority). A module-level seam in the
// style of audio/audioBus.ts: entries that can spawn a Web Worker install `createWorkerJudgeExecutor`
// (platform/web/workerJudge.ts); everything else — the WeChat bundle must stay a single file with no
// worker chunk — keeps the default, which runs short main-thread slices and parks while a battle is
// on screen.

import type { JudgeRequest } from './proto/transport';
import { runJudgeSliced, type JudgeOutcome } from './judgeRunner';
import { isBattleBusy } from './battleBusy';

export type JudgeExecutor = (req: JudgeRequest) => Promise<JudgeOutcome>;

/**
 * Give up once the gateway has stopped waiting (its JUDGE_TIMEOUT_MS is 20 s): a late verdict is
 * discarded server-side, so finishing would only burn the player's CPU.
 */
export const JUDGE_DEADLINE_MS = 19_000;

/**
 * Main-thread slice, then yield a whole frame. 30 frames is a few ms of engine work on a phone (a
 * heavy campaign level costs ~0.025 ms/frame in Node) and keeps a 9000-frame match inside the deadline.
 */
const MAIN_SLICE_TICKS = 30;
const MAIN_PAUSE_MS = 16;

export class JudgeDeadlineError extends Error {
  constructor() {
    super('judge deadline passed');
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mainThreadExecutor: JudgeExecutor = (req) => {
  const deadline = Date.now() + JUDGE_DEADLINE_MS;
  return runJudgeSliced(
    req,
    async () => {
      // A battle may start mid-recompute: stop stepping entirely until it ends (or the deadline passes).
      do {
        if (Date.now() > deadline) throw new JudgeDeadlineError();
        await sleep(MAIN_PAUSE_MS);
      } while (isBattleBusy());
    },
    MAIN_SLICE_TICKS,
  );
};

let executor: JudgeExecutor = mainThreadExecutor;

export function setJudgeExecutor(e: JudgeExecutor): void {
  executor = e;
}

export function executeJudge(req: JudgeRequest): Promise<JudgeOutcome> {
  return executor(req);
}
