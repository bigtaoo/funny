// Web-family judge executor: one long-lived Web Worker (net/judge.worker.ts) runs every recompute
// off the main thread. Installed from the web / CrazyGames / mobile entries only — the WeChat
// bundle can't carry a worker chunk (webpack asyncChunks:false) and keeps the main-thread default.
// scripts/checkWechatPackage.mjs (rule 5) spots this module in the WeChat bundle by its two log
// strings below — keep them in step if they are reworded.

import type { JudgeExecutor } from '../../net/judgeExecutor';
import type { JudgeOutcome } from '../../net/judgeRunner';
import type { JudgeWorkerRequest } from '../../net/judge.worker';
import { netLog } from '../../net/log';

const log = netLog('judge');
const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' };

/** Returns null when this runtime has no Worker (the caller then keeps the default executor). */
export function createWorkerJudgeExecutor(): JudgeExecutor | null {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, (out: JudgeOutcome) => void>();

  const failAll = (): void => {
    for (const resolve of pending.values()) resolve(FAIL);
    pending.clear();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL('../../net/judge.worker.ts', import.meta.url));
    w.onmessage = (e: MessageEvent<{ id: number; out: JudgeOutcome }>) => {
      const resolve = pending.get(e.data.id);
      pending.delete(e.data.id);
      resolve?.(e.data.out);
    };
    w.onerror = (e) => {
      log.warn('judge worker crashed', { message: e.message });
      w.terminate();
      if (worker === w) worker = null;
      failAll();
    };
    worker = w;
    return w;
  };

  return (req) =>
    new Promise<JudgeOutcome>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      try {
        const msg: JudgeWorkerRequest = { id, req };
        ensureWorker().postMessage(msg);
      } catch (e) {
        log.warn('judge worker unavailable', { message: (e as Error).message });
        pending.delete(id);
        resolve(FAIL);
      }
    });
}
