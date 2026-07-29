// Test-only worker fixture for siegeWorkerPool.test.ts: accepts a task message and never responds,
// simulating a hung worker (e.g. a future engine bug that spins forever) for exercising the pool's
// per-task timeout + forced-terminate-and-respawn path. Deliberately does NOT block its own event loop
// (no busy-loop) — it just never calls postMessage — so `worker.terminate()` from the pool can still land.
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('hangWorker.ts must be run inside a worker_thread (parentPort is null)');
}

parentPort.on('message', () => {
  /* intentionally never respond */
});
