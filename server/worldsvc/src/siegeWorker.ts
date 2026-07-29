// Worker-thread entry point for the siege engine pool (siegeWorkerPool.ts). Runs inside a `worker_threads`
// Worker, never on the main thread. Receives one `SiegeBattleInput` per message (structured-clone safe —
// plain GarrisonEntry[]/card/equipment data, no functions/class instances), runs the exact same
// `runSiegeBattleSync` the main thread used to call directly, and posts the `SiegeResolution` back.
//
// No Mongo/DB access here and none should ever be added — all persistence stays on the main thread in
// combatSiege/{arrival,occupation,encounter}.ts; this file's only job is the pure CPU-bound computation.
import { parentPort } from 'node:worker_threads';
import { runSiegeBattleSync, type SiegeBattleInput } from './siegeEngine';
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

parentPort.on('message', (msg: TaskRequest) => {
  let response: TaskResponse;
  try {
    const result = runSiegeBattleSync(msg.input);
    response = { taskId: msg.taskId, ok: true, result };
  } catch (err) {
    response = { taskId: msg.taskId, ok: false, error: (err as Error).message };
  }
  parentPort!.postMessage(response);
});
