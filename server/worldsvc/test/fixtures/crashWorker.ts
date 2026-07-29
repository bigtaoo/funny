// Test-only worker fixture for siegeWorkerPool.test.ts: crashes (hard `process.exit`) the instant it
// receives its first task message, instead of computing a real siege result. Used to exercise
// SiegeWorkerPool's crash-detection + respawn path deterministically, without needing to provoke a real
// bug in the engine. Every freshly spawned instance of this worker crashes on its first message (module
// state is per-worker, so a respawned replacement crashes again just as reliably) — that's what lets the
// test assert "self-heals repeatedly", not just once.
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('crashWorker.ts must be run inside a worker_thread (parentPort is null)');
}

parentPort.on('message', () => {
  process.exit(1);
});
