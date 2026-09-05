// worker_threads pool for worldsvc's CPU-bound computation (siege battles + march pathfinding).
//
// Problem: `runHeadless` (server/engine/src/runHeadless.ts) is a fully synchronous `while` loop — a
// close-to-even-strength base siege can run up to SIEGE_BATTLE_TIMEOUT_TICKS(=18000)+TICK_MARGIN(=600)
// ticks with real per-tick allocation (CombatSystem.tick). Running that on worldsvc's single event loop
// (from a `setInterval`-driven background scheduler tick, not a synchronous HTTP handler — see
// `scheduler.ts`) blocks every other request/tile settlement on the process for the full battle duration.
// `shouldUseCheapSiege` already routes lopsided fights to the cheap linear formula; evenly-matched fights
// are exactly the ones that reach here and cannot be filtered away (that's a balance decision, not a perf
// bug — see siegeEngine.ts).
//
// Fix: move the actual `runHeadless` computation into a small pool of long-lived worker threads. Callers
// (combatSiege/{arrival,occupation,encounter}.ts) already treat the engine call as a fallible step inside
// an `async` function (`try { res = runSiegeBattle(...) } catch`), so turning it into `await
// runSiegeBattle(...)` is a drop-in change — no caller restructuring needed. `@nw/engine` has zero runtime
// Node API usage (pure fixed-point TS, injected PRNG/InputSource — see server/engine/package.json), so it
// runs unmodified inside a worker; only "where do we read input / write output" changes (worker.ts wraps
// the existing `runSiegeBattleSync`, formerly the sole `runSiegeBattle` export, in a postMessage handler).
// All Mongo access stays on the main thread — only this pure CPU computation crosses the thread boundary.
//
// 2026-09-05 (worldsvc-concurrency): generalised from siege-only to a task union, and put behind the
// ComputeBackend interface in ./types.ts. The second tenant is A* march pathfinding, which the concurrency
// audit measured blocking the loop for 2-6 SECONDS on an unreachable target — the same disease as the
// siege engine, on a path every single march order goes through. Everything about the pool's shape
// (long-lived workers, idle-or-queue scheduling, crash self-heal, per-task hang guard) is unchanged; only
// the message payload became a discriminated union and `submit` became typed per task kind.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import type { SiegeResolution, PathCell } from '@nw/shared';
import type { SiegeBattleInput } from '../siegeEngine';
import type { ComputeBackend, PathRequest } from './types';

// Running under `tsx` (dev `node --watch --import tsx src/index.ts`, and vitest, which transpiles on the
// fly) __filename still ends in `.ts`; after `tsc -b` (prod `node dist/index.js`) it ends in `.js` and the
// compiled `siegeWorker.js` sits right next to this file in `dist/`. Passing `--import tsx` as the worker's
// own execArgv makes the *worker thread* (a separate V8 isolate — it does NOT inherit the parent's CLI
// flags/loader hooks) able to load the `.ts` source directly, mirroring how the main process itself is
// invoked in dev. In prod this branch never triggers — `tsx` stays a devDependency only.
const IS_TS_RUNTIME = __filename.endsWith('.ts');
const DEFAULT_WORKER_PATH = path.join(__dirname, IS_TS_RUNTIME ? 'worker.ts' : 'worker.js');

/** `--import tsx` is only needed when the worker script itself is `.ts` source (dev/test); a compiled `.js` worker runs with plain `node`. */
function execArgvFor(workerPath: string): string[] {
  return workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [];
}

/** `os.cpus().length - 1` (leave one core for the event loop + everything else on the box), min 1. Override via `NW_COMPUTE_POOL_SIZE`. */
export function defaultComputePoolSize(): number {
  const cpus = os.cpus().length || 1;
  return Math.max(1, cpus - 1);
}

/** A hung worker (stuck tick loop / bad engine bug) is terminated and replaced after this long. Override via `NW_COMPUTE_TASK_TIMEOUT_MS`. */
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

/**
 * What crosses the thread boundary. Structured-clone safe by construction: plain data only, no functions,
 * no class instances — the same constraint the future remote backend will have to satisfy over JSON.
 */
export type ComputeJob =
  | { kind: 'siege'; input: SiegeBattleInput }
  | { kind: 'path'; input: PathRequest }
  /** Force the per-world terrain/connectivity index to be built now (see warmWorld). */
  | { kind: 'warm'; input: { world: string; mapW: number; mapH: number } };

/** Result shape per job kind, so `submit` can be typed without a cast at each call site. */
export type ComputeJobResult<J extends ComputeJob> =
  J extends { kind: 'siege' } ? SiegeResolution
    : J extends { kind: 'path' } ? PathCell[] | null
      : void;

interface TaskRequest {
  taskId: number;
  job: ComputeJob;
}
type TaskResponse =
  | { taskId: number; ok: true; result: unknown }
  | { taskId: number; ok: false; error: string };

interface PendingTask {
  taskId: number;
  job: ComputeJob;
  resolve: (r: never) => void;
  reject: (e: Error) => void;
  /**
   * Hang-guard timer, armed only once the task is actually handed to a worker (see `dispatch`) — null while
   * still sitting in `queue`. Arming it at `submit()` time instead (the original implementation) meant a
   * task that waited in the queue longer than `taskTimeoutMs` under load lost its hang protection forever:
   * the one-shot timer fired while the task had no assigned worker (`onTaskTimeout` no-ops on that, by
   * design, since a queued task isn't "hung"), and nothing ever re-armed it once a worker picked it up.
   */
  timer: NodeJS.Timeout | null;
}

interface PoolWorker {
  worker: Worker;
  /** taskId currently running on this worker, or null when idle. */
  currentTaskId: number | null;
  /** Set once terminate/crash handling has started, so the 'error' + 'exit' pair (both fire on a crash) only self-heals once. */
  retiring: boolean;
}

/**
 * Fixed-size pool of long-lived worker threads that run `runSiegeBattleSync` off the main thread.
 * Workers are NOT spawned per-battle (measured worker startup is tens of ms — not worth paying per siege);
 * the pool is built once and reused for the life of the process.
 *
 * Scheduling: a simple idle-worker-or-queue design — no external dependency needed for a pool this small.
 * `submit` always resolves/rejects eventually; there is no "pool full → reject" path (S8-3b-adjacent siege
 * settlement is a background scheduler tick, not a synchronous HTTP request — queuing under load is fine,
 * see design/game/SERVER_LOGIC_AUDIT_2026-07-29.md item 3).
 */
export class ComputeWorkerPool implements ComputeBackend {
  readonly name = 'worker';

  private readonly workers: PoolWorker[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly pending = new Map<number, PendingTask>();
  private nextTaskId = 1;
  private closed = false;
  private readonly taskTimeoutMs: number;
  private readonly workerPath: string;
  private readonly workerExecArgv: string[];

  /**
   * @param size Worker count, default {@link defaultComputePoolSize}.
   * @param taskTimeoutMs Per-task hang guard, default {@link DEFAULT_TASK_TIMEOUT_MS}.
   * @param workerScriptPath Test-only override of the worker entry script (e.g. a fixture that crashes on
   *   command, for exercising crash/self-heal deterministically) — production code never passes this.
   */
  constructor(
    size: number = defaultComputePoolSize(),
    taskTimeoutMs: number = DEFAULT_TASK_TIMEOUT_MS,
    workerScriptPath: string = DEFAULT_WORKER_PATH,
  ) {
    this.taskTimeoutMs = taskTimeoutMs;
    this.workerPath = workerScriptPath;
    this.workerExecArgv = execArgvFor(workerScriptPath);
    for (let i = 0; i < Math.max(1, size); i++) this.spawnWorker();
  }

  private spawnWorker(): void {
    // 2026-08-14 fix (see compute/worker.ts's own comment): pass the dev/prod extension as workerData
    // instead of letting the worker recompute it via `__filename.endsWith('.ts')` — confirmed on
    // real Linux CI that tsx's `--import` hook runs the worker's entry module under ESM semantics
    // (even though the file is .ts and the nearest package.json has no "type": "module"), where
    // `__filename` is simply undefined; `import.meta.url` would be the ESM-safe equivalent, but this
    // project's tsconfig targets `module: CommonJS` and TS rejects `import.meta` syntax outright
    // under that setting (same TS5097-style incompatibility as the earlier `.ts`-extension attempt).
    // workerData sidesteps needing either global inside the worker at all: this file (compute/pool.ts)
    // is always the true entry, always runs on the main thread in real CommonJS, so `IS_TS_RUNTIME`
    // computed here is reliable.
    const worker = new Worker(this.workerPath, {
      execArgv: this.workerExecArgv,
      workerData: { ext: IS_TS_RUNTIME ? '.ts' : '.js' },
    });
    const entry: PoolWorker = { worker, currentTaskId: null, retiring: false };
    worker.on('message', (msg: TaskResponse) => this.onMessage(entry, msg));
    worker.on('error', (err) => this.onWorkerDown(entry, err));
    worker.on('exit', (code) => {
      if (code !== 0) this.onWorkerDown(entry, new Error(`compute worker exited with code ${code}`));
    });
    // Deliberately left ref'd (Node's default): an idle worker keeps the process alive, same as an open
    // Mongo/Redis connection or listening HTTP socket. Tried `.unref()` here on the theory that it would
    // save short-lived scripts from hanging if they forget `close()` — but that's backwards: `.unref()`
    // means the *only* pending activity (a submitted battle whose result hasn't arrived yet) no longer
    // counts as keeping the event loop alive either, so a bare script/tool with nothing else ref'd can
    // exit before its own `pool.submit()` promise ever resolves (caught this exact silent-exit-with-no-
    // output failure while smoke-testing the compiled dist build). worldsvc's real process always has
    // other ref'd handles (HTTP server, Mongo, scheduler timer) so this was never observable there — but
    // it is a footgun for any future standalone consumer (a `tools/` script, a one-off REPL check). The
    // correct way to let a short-lived process exit promptly is the explicit `close()` this class already
    // provides (wired into index.ts's shutdown handler; test files call it in `afterEach`).
    this.workers.push(entry);
  }

  private onMessage(entry: PoolWorker, msg: TaskResponse): void {
    const task = this.pending.get(msg.taskId);
    entry.currentTaskId = null;
    if (!task) return; // already timed out / worker replaced — response arrived late, discard
    this.pending.delete(msg.taskId);
    if (task.timer) clearTimeout(task.timer);
    if (msg.ok) task.resolve(msg.result as never);
    else task.reject(new Error(msg.error));
    this.dispatch();
  }

  /** A worker crashed (uncaught exception → 'error', or died → non-zero 'exit'): reject its in-flight task (if any), retire it, spawn a replacement. */
  private onWorkerDown(entry: PoolWorker, err: Error): void {
    if (entry.retiring) return; // 'error' and 'exit' both fire for the same crash; handle once
    entry.retiring = true;

    const idx = this.workers.indexOf(entry);
    if (idx >= 0) this.workers.splice(idx, 1);
    try {
      void entry.worker.terminate();
    } catch {
      /* already dead */
    }

    if (entry.currentTaskId != null) {
      const task = this.pending.get(entry.currentTaskId);
      if (task) {
        this.pending.delete(entry.currentTaskId);
        if (task.timer) clearTimeout(task.timer);
        task.reject(new Error(`compute worker crashed mid-job: ${err.message}`));
      }
    }

    if (!this.closed) {
      this.spawnWorker();
      this.dispatch();
    }
  }

  /** Submit one job for computation on the pool. Never rejects due to "pool full" — queues instead. */
  submit<J extends ComputeJob>(job: J): Promise<ComputeJobResult<J>> {
    if (this.closed) return Promise.reject(new Error('compute worker pool is closed'));
    return new Promise<ComputeJobResult<J>>((resolve, reject) => {
      const taskId = this.nextTaskId++;
      // No timer yet — armed in `dispatch()` once a worker actually picks this up (see PendingTask.timer doc).
      this.queue.push({ taskId, job, resolve: resolve as (r: never) => void, reject, timer: null });
      this.dispatch();
    });
  }

  // ── ComputeBackend ────────────────────────────────────────────────────────────

  runSiege(input: SiegeBattleInput): Promise<SiegeResolution> {
    return this.submit({ kind: 'siege', input });
  }

  findPath(input: PathRequest): Promise<PathCell[] | null> {
    return this.submit({ kind: 'path', input });
  }

  /**
   * Build the per-world terrain index on EVERY worker, not just one: each thread has its own heap, so a
   * world warmed on one worker is still cold on the next, and a request that lands there pays the ~2.5s
   * build while holding that worker.
   *
   * "Every worker" relies on `dispatch` handing each queued job to a DIFFERENT idle worker, which holds
   * exactly when the pool is idle — the boot-time call this exists for. Called under load it degrades to
   * "some workers warmed twice, some not at all", which costs a rebuild rather than a wrong answer, so it
   * is not worth a per-worker addressing mechanism the pool otherwise has no use for.
   *
   * Best-effort by contract (see ComputeBackend.warmWorld): a failure means the first real path request
   * for this world is slow, never that it is wrong, so failures are swallowed rather than propagated.
   */
  async warmWorld(world: string, mapW: number, mapH: number): Promise<void> {
    const jobs = this.workers.map(() => this.submit({ kind: 'warm', input: { world, mapW, mapH } }).catch(() => undefined));
    await Promise.all(jobs);
  }

  private onTaskTimeout(taskId: number): void {
    const task = this.pending.get(taskId);
    if (!task) return; // already resolved (queued-but-undispatched tasks have no timer and can't reach here)
    this.pending.delete(taskId);
    // Find and retire whichever worker is stuck on this task — it's hung (bad engine bug / infinite loop),
    // not merely slow, so terminating it (rather than waiting indefinitely) keeps the pool from shrinking
    // to zero usable workers over time.
    const stuck = this.workers.find((w) => w.currentTaskId === taskId);
    if (stuck) this.onWorkerDown(stuck, new Error(`compute job '${task.job.kind}' exceeded ${this.taskTimeoutMs}ms`));
    task.reject(new Error(`compute job '${task.job.kind}' timed out after ${this.taskTimeoutMs}ms`));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => w.currentTaskId == null);
      if (!idle) return;
      const task = this.queue.shift()!;
      // Arm the hang-guard timer now that the task is actually running on a worker, not back when it was
      // merely submitted (see PendingTask.timer doc) — a task that waited a while in queue still gets the
      // full `taskTimeoutMs` from the moment real work starts.
      task.timer = setTimeout(() => this.onTaskTimeout(task.taskId), this.taskTimeoutMs);
      task.timer.unref?.();
      idle.currentTaskId = task.taskId;
      this.pending.set(task.taskId, task);
      const req: TaskRequest = { taskId: task.taskId, job: task.job };
      idle.worker.postMessage(req);
    }
  }

  /** Number of workers currently in the pool (for tests / diagnostics). */
  get size(): number {
    return this.workers.length;
  }

  /** Terminate every worker and reject anything still queued/in-flight. Call on process shutdown (or between tests). */
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(new Error('compute worker pool closed'));
    }
    for (const task of this.pending.values()) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(new Error('compute worker pool closed'));
    }
    this.pending.clear();
    await Promise.all(this.workers.splice(0).map((w) => w.worker.terminate()));
  }
}
