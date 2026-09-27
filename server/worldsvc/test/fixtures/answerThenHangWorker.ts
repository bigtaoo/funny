// Test-only worker fixture for computePool.test.ts: answers each of the first 5 task messages immediately
// (fabricated result, not a real engine run), then hangs forever on every message after that. On a
// single-worker pool this lets several tasks pile up ahead of a 6th in `queue`, reproducing the scenario
// that exposed the dispatch-time-vs-submit-time timer arming bug (server-logic-audit-2026-07-29 follow-up):
// a task that waited past its timeout while merely queued must still get full hang protection once a worker
// actually starts running it. The test drives the pool's hang-guard clock with fake timers, so how long the
// worker really takes to start or answer never enters into it.
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('answerThenHangWorker.ts must be run inside a worker_thread (parentPort is null)');
}

let count = 0;
parentPort.on('message', (msg: { taskId: number }) => {
  count++;
  if (count > 5) return; // hang from the 6th message onward
  parentPort!.postMessage({ taskId: msg.taskId, ok: true, result: {} });
});
