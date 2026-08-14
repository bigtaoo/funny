// Worker-thread entry point for the siege engine pool (siegeWorkerPool.ts). Runs inside a `worker_threads`
// Worker, never on the main thread. Receives one `SiegeBattleInput` per message (structured-clone safe —
// plain GarrisonEntry[]/card/equipment data, no functions/class instances), runs the exact same
// `runSiegeBattleSync` the main thread used to call directly, and posts the `SiegeResolution` back.
//
// No Mongo/DB access here and none should ever be added — all persistence stays on the main thread in
// combatSiege/{arrival,occupation,encounter}.ts; this file's only job is the pure CPU-bound computation.
import { parentPort } from 'node:worker_threads';
import type { SiegeBattleInput } from './siegeEngine';
import type { SiegeResolution } from '@nw/shared';

if (!parentPort) {
  throw new Error('siegeWorker.ts must be run inside a worker_thread (parentPort is null)');
}

interface TaskRequest {
  taskId: number;
  input: SiegeBattleInput;
}
type TaskResponse =
  | { taskId: number; ok: true; result: SiegeResolution }
  | { taskId: number; ok: false; error: string };

async function main(): Promise<void> {
  // 2026-08-14 fix (CI-only worker crash): a plain static `import './siegeEngine'` (no extension,
  // the codebase-wide convention — nothing else here writes explicit extensions) reliably failed
  // to resolve on Linux CI, 100% reproducible on every single task: "Cannot find module
  // '.../siegeEngine' imported from '.../siegeWorker.ts'" — this file's own worker_thread is loaded
  // via tsx (`--import tsx`, siegeWorkerPool.ts's execArgv) in dev/test, and something about tsx's
  // extensionless-specifier resolution inside a worker_thread realm breaks specifically on Linux
  // (worked fine locally on Windows; couldn't get a Linux box to bisect further — this codebase's
  // dev machine is Windows, so this had apparently never been exercised on Linux before real e2e
  // tests started actually running in CI). The worker's OWN entry path — computed next door in
  // siegeWorkerPool.ts's DEFAULT_WORKER_PATH — already sidesteps the exact same ambiguity by using
  // an EXPLICIT, runtime-computed extension (`.ts` under tsx/vitest, `.js` after `tsc -b`) instead of
  // letting the loader guess one; mirroring that same technique here for our own sibling import.
  // A dynamic import (rather than a static one) is required to spell out `.ts` at all: this project
  // compiles to real .js (not just type-checks), so a STATIC `.ts`-suffixed specifier is a hard `tsc
  // -b` error (TS5097, needs `allowImportingTsExtensions` — incompatible with real emit); a
  // template-literal specifier isn't statically analyzable, so TS doesn't apply that check to it.
  const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
  const { runSiegeBattleSync } = (await import(`./siegeEngine${ext}`)) as typeof import('./siegeEngine');

  parentPort!.on('message', (msg: TaskRequest) => {
    let response: TaskResponse;
    try {
      const result = runSiegeBattleSync(msg.input);
      response = { taskId: msg.taskId, ok: true, result };
    } catch (err) {
      response = { taskId: msg.taskId, ok: false, error: (err as Error).message };
    }
    parentPort!.postMessage(response);
  });
}

// Setup failure (e.g. the dynamic import above itself can't resolve) is surfaced as a normal worker
// error so siegeWorkerPool's existing crash-recovery (onWorkerDown/'error' handler) treats it the same
// as any other startup failure, instead of Node logging an unhandled rejection and hanging the worker.
main().catch((err) => {
  throw err;
});
