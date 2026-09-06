// Compute backend selection + process-wide singleton (worldsvc-concurrency-2026-09-05).
//
// Call sites (siegeEngine.ts, combatShared.ts) go through `getComputeBackend()` and never construct a
// backend themselves, so moving this computation out to a separate service later is a config change —
// see ./types.ts for the phase-4 note and ./remote.ts for the contract that service must satisfy.
import { ComputeWorkerPool, defaultComputePoolSize } from './pool';
import { RemoteComputeBackend } from './remote';
import type { ComputeBackend } from './types';

export type { ComputeBackend, PathRequest } from './types';
export { ComputeWorkerPool, defaultComputePoolSize } from './pool';

let singleton: ComputeBackend | null = null;

/**
 * Process-wide compute backend, lazily constructed on first use — laziness matters: this module is
 * reachable from siegeEngine.ts, which the worker thread itself loads, and constructing the pool eagerly
 * there would spawn workers inside a worker.
 *
 * `NW_COMPUTE_BACKEND=remote` selects the (not yet built) standalone service; anything else, including
 * unset, gives the in-process worker pool.
 */
export function getComputeBackend(): ComputeBackend {
  if (!singleton) {
    if ((process.env.NW_COMPUTE_BACKEND ?? '').toLowerCase() === 'remote') {
      singleton = new RemoteComputeBackend(process.env.NW_COMPUTE_URL ?? '', process.env.NW_INTERNAL_KEY ?? '');
    } else {
      const size = Number(process.env.NW_COMPUTE_POOL_SIZE) || defaultComputePoolSize();
      const taskTimeoutMs = Number(process.env.NW_COMPUTE_TASK_TIMEOUT_MS) || undefined;
      singleton = new ComputeWorkerPool(size, taskTimeoutMs);
    }
  }
  return singleton;
}

/** Graceful shutdown hook (index.ts) — also lets tests reset the singleton between suites. */
export async function shutdownComputeBackend(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
