// Test-only worker fixture for siegeWorkerPool.test.ts: responds to each of the first 5 task messages
// (fabricated result, not a real engine run) after a fixed delay, then hangs forever on every message after
// that. On a single-worker pool this lets several quick-but-non-instant tasks pile up ahead of a 6th in
// `queue` long enough that the 6th's wait-in-queue alone exceeds a shorter taskTimeoutMs before it's ever
// dispatched — reproducing the scenario that exposed the dispatch-time-vs-submit-time timer arming bug
// (server-logic-audit-2026-07-29 follow-up): a task that waited past its timeout while merely queued must
// still get full hang protection once a worker actually starts running it. The per-message delay and
// timeout in the test are both generous relative to it, to absorb worker-thread cold-start jitter on the
// very first message without that alone tripping the timeout.
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('slowThenHangWorker.ts must be run inside a worker_thread (parentPort is null)');
}

let count = 0;
parentPort.on('message', (msg: { taskId: number }) => {
  count++;
  if (count > 5) return; // hang from the 6th message onward
  setTimeout(() => {
    parentPort!.postMessage({ taskId: msg.taskId, ok: true, result: {} });
  }, 150);
});
