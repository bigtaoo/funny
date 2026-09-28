// Unit tests for ComputeWorkerPool (server-logic-audit-2026-07-29 item 3 moved siegeEngine off the main
// thread; worldsvc-concurrency-2026-09-05 generalised the pool and added march pathfinding as its second
// tenant). No Mongo needed: these exercise the pool in isolation, not the worldsvc business logic around it
// (that's covered by the existing siege/base-siege/stronghold/passage/field-encounter e2e suites, which all
// still pass unchanged now that `runSiegeBattle` is async — see siegeEngine.ts).
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeWorkerPool, defaultComputePoolSize } from '../src/compute/pool';
import { routeTimings } from '../src/metrics';
import { runSiegeBattleSync, synthesizeArmy, SIEGE_SYNTH_ARMY_MAX_TROOPS, type SiegeBattleInput } from '../src/siegeEngine';

const CRASH_WORKER = path.join(__dirname, 'fixtures', 'crashWorker.ts');
const HANG_WORKER = path.join(__dirname, 'fixtures', 'hangWorker.ts');
const ANSWER_THEN_HANG_WORKER = path.join(__dirname, 'fixtures', 'answerThenHangWorker.ts');

/** A real, non-trivial siege battle input (full-board armies) — deterministic, CPU-heavy enough (tens of ms)
 * to make wall-clock parallelism comparisons meaningful without making the test suite slow. */
function bigEvenBattle(seed: number): SiegeBattleInput {
  return {
    attackerArmy: synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS, 'attacker'),
    defenderConfig: { garrison: synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS, 'defender') },
    tileLevel: 1,
    seed,
  };
}

const pools: ComputeWorkerPool[] = [];
function makePool(...args: ConstructorParameters<typeof ComputeWorkerPool>): ComputeWorkerPool {
  const pool = new ComputeWorkerPool(...args);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe('defaultComputePoolSize', () => {
  it('is at least 1 and at most cpus-1', () => {
    const n = defaultComputePoolSize();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(Math.max(1, os.cpus().length - 1));
  });
});

describe('ComputeWorkerPool timing labels (ADR-092 / audit §12.7 phase 0)', () => {
  it('records queue wait and on-worker run per job kind, and a single worker makes the second task wait', async () => {
    routeTimings.drain();
    const pool = makePool(1);
    pool.timingSink = (label, ms) => routeTimings.record(label, ms);
    await Promise.all([pool.runSiege(bigEvenBattle(1)), pool.runSiege(bigEvenBattle(2))]);
    const snap = routeTimings.snapshot();
    const run = snap['compute:siege:run']!;
    const wait = snap['compute:siege:wait']!;
    expect(run.count).toBe(2);
    expect(wait.count).toBe(2);
    // One worker: the second battle queues behind the first, so the longest wait covers at least most
    // of one run. That queueing is exactly what prod's single worker (2 vCPU) does to every world.
    expect(wait.max).toBeGreaterThanOrEqual(run.max * 0.5);
    routeTimings.drain();
  });
});

describe('ComputeWorkerPool basic scheduling', () => {
  it('runSiege resolves with the exact same result runSiegeBattleSync produces for the same input (determinism unaffected by moving execution to a worker)', async () => {
    const pool = makePool(2);
    const input = bigEvenBattle(1234);
    const expected = runSiegeBattleSync(input);
    const actual = await pool.runSiege(input);
    expect(actual).toEqual(expected);
  });

  it('handles many small tasks on a single worker (queue drains fully, nothing lost)', async () => {
    const pool = makePool(1);
    const inputs = Array.from({ length: 12 }, (_, i) => ({
      attackerArmy: synthesizeArmy(500 + i, 'attacker'),
      defenderConfig: { garrison: synthesizeArmy(200, 'defender') },
      tileLevel: 1,
      seed: i,
    }));
    const results = await Promise.all(inputs.map((inp) => pool.runSiege(inp)));
    expect(results).toHaveLength(12);
    // Cross-check every result against the pure sync function for the same input.
    inputs.forEach((inp, i) => {
      expect(results[i]).toEqual(runSiegeBattleSync(inp));
    });
  });

  it('bad input (invalid formation) rejects the runSiege() promise rather than hanging or crashing the worker', async () => {
    const pool = makePool(1);
    const badInput: SiegeBattleInput = {
      attackerArmy: [{ unitType: synthesizeArmy(60, 'attacker')[0]!.unitType, col: -999, row: -999, initialHp: 60 }],
      defenderConfig: null,
      tileLevel: 1,
      seed: 1,
    };
    await expect(pool.runSiege(badInput)).rejects.toThrow();
    // The worker itself survived (caught the error internally, per compute/worker.ts) — a follow-up good task
    // on the same pool still succeeds, proving the worker wasn't torn down by the bad input.
    const good = bigEvenBattle(2);
    await expect(pool.runSiege(good)).resolves.toEqual(runSiegeBattleSync(good));
  });
});

describe('ComputeWorkerPool crash self-heal', () => {
  it('a worker that hard-crashes mid-task rejects that task and the pool respawns a replacement (size unchanged)', async () => {
    const pool = makePool(1, 30_000, CRASH_WORKER);
    expect(pool.size).toBe(1);

    await expect(pool.runSiege(bigEvenBattle(1))).rejects.toThrow(/crashed/);
    // Pool self-healed: still exactly 1 worker (the crashed one was replaced, not just removed).
    expect(pool.size).toBe(1);

    // Self-heal is not a one-shot fluke: the pool survives repeated crashes (every fresh crashWorker
    // instance crashes again on its first message).
    await expect(pool.runSiege(bigEvenBattle(2))).rejects.toThrow(/crashed/);
    expect(pool.size).toBe(1);
    await expect(pool.runSiege(bigEvenBattle(3))).rejects.toThrow(/crashed/);
    expect(pool.size).toBe(1);
  });

  it('a crash only rejects the task that was in flight on that worker; concurrent tasks on other workers are unaffected', async () => {
    const pool = makePool(2, 30_000, CRASH_WORKER);
    // Both workers crash immediately on their first message, but each task's own rejection is independent.
    const results = await Promise.allSettled([pool.runSiege(bigEvenBattle(1)), pool.runSiege(bigEvenBattle(2))]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(pool.size).toBe(2); // both replaced
  });
});

describe('ComputeWorkerPool task timeout', () => {
  it('a hung worker (never responds) is terminated and its task rejects after the configured timeout; pool size is restored', async () => {
    const pool = makePool(1, 200, HANG_WORKER); // 200ms timeout — short for test speed
    const start = Date.now();
    await expect(pool.runSiege(bigEvenBattle(1))).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(190); // allow a few ms of scheduling slop
    expect(pool.size).toBe(1); // hung worker was terminated + replaced
  });

  it('reports the timeout and the worker restart to the event sink (both used to be silent)', async () => {
    const pool = makePool(1, 200, HANG_WORKER);
    const events: string[] = [];
    pool.eventSink = (event) => events.push(event);
    await expect(pool.runSiege(bigEvenBattle(1))).rejects.toThrow(/timed out/);
    expect(events).toEqual(['compute.timeout.siege', 'compute.workerDown']);
  });
});

describe('ComputeWorkerPool task timeout (dispatch-time arming regression)', () => {
  it('a task queued past taskTimeoutMs behind several others still gets full hang protection once it is actually dispatched', async () => {
    // Single worker so tasks run strictly one at a time. The fixture answers the first 5 messages and hangs on
    // the 6th. Only the pool's hang-guard clock (setTimeout/clearTimeout on this thread) is faked: the worker
    // thread and its messages stay real, but no timeout can fire unless the test advances the clock. That
    // makes the test independent of wall-clock load — a cold worker start or a busy machine used to eat the
    // first task's real 400ms budget (seen twice as a flake under a concurrent `npm install`, 2026-09-27).
    //
    // Each of the first 5 tasks is left in flight for 0.9 × taskTimeoutMs of fake time, so none of them times
    // out, but the 6th sits in `queue` for 4.5 × taskTimeoutMs before a worker is free for it. Before the fix,
    // its hang-guard timer was armed at submit() time (t=0) and fired at t=T while it was still queued — a
    // documented no-op (queued tasks aren't in `pending` yet) — leaving nothing to re-arm it once it was
    // dispatched onto a worker that then hangs forever. The fix arms the timer in `dispatch()`, so the 6th
    // task gets its own full T of hang protection starting from when it actually begins running.
    const T = 400;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pool = makePool(1, T, ANSWER_THEN_HANG_WORKER);
      const submissions = Array.from({ length: 6 }, (_, i) => pool.runSiege(bigEvenBattle(i)));
      let lastError: unknown = null;
      submissions[5]!.catch((e: unknown) => (lastError = e));

      // Synchronous advances only: no worker message can be handled mid-advance, so exactly one known task is
      // in flight each time. (After task i-1's answer, task i is dispatched in the same handler, and the
      // await continuation below runs as a microtask before task i's own answer can arrive.)
      const flush = () => new Promise((r) => setImmediate(r));
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(T * 0.9); // task i is in flight: just short of its own timeout
        await expect(submissions[i]).resolves.toBeDefined(); // waits (real time) for the worker's answer
      }
      // The 6th is now dispatched onto the worker that will hang on it; fake time is already 4.5 × T.
      vi.advanceTimersByTime(T - 1);
      await flush();
      expect(lastError).toBeNull(); // full window from dispatch, not from submit
      vi.advanceTimersByTime(1);
      await flush();
      expect(String(lastError)).toMatch(/timed out/);
      expect(pool.size).toBe(1); // hung worker detected + replaced
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ComputeWorkerPool queueing under load', () => {
  it('more in-flight submissions than workers still all resolve (queued, not rejected/dropped)', async () => {
    const pool = makePool(2);
    const inputs = Array.from({ length: 6 }, (_, i) => bigEvenBattle(100 + i));
    const results = await Promise.all(inputs.map((inp) => pool.runSiege(inp)));
    expect(results).toHaveLength(6);
    inputs.forEach((inp, i) => expect(results[i]).toEqual(runSiegeBattleSync(inp)));
  });
});

describe('ComputeWorkerPool close()', () => {
  it('rejects in-flight and queued tasks, and rejects any further submissions', async () => {
    const pool = new ComputeWorkerPool(1); // not auto-closed by afterEach — closed manually below
    const queued = pool.runSiege(bigEvenBattle(1));
    const closeP = pool.close();
    await expect(queued).rejects.toThrow(/closed/);
    await closeP;
    await expect(pool.runSiege(bigEvenBattle(2))).rejects.toThrow(/closed/);
  });
});

describe('ComputeWorkerPool wall-clock parallelism (the "free lunch" the audit called out: scheduler.ts\'s Promise.allSettled over concurrent siege battles used to serialize on one thread; the pool actually spreads them across cores)', () => {
  it('N concurrent heavy battles on an N-worker pool complete in well under N× a single battle\'s time (real cross-core parallelism, not queued serial execution)', async () => {
    const N = 6;
    const pool = makePool(N);
    const inputs = Array.from({ length: N }, (_, i) => bigEvenBattle(1000 + i));

    // Warm up every worker first (module load / tsx transpile / JIT is a one-time per-worker cost that a
    // real long-lived worldsvc process pays once at boot, not per battle — excluding it here is what makes
    // this a fair "steady state" comparison instead of measuring pool cold-start).
    const warmup = Array.from({ length: N }, (_, i) => bigEvenBattle(9000 + i));
    await Promise.all(warmup.map((inp) => pool.runSiege(inp)));
    runSiegeBattleSync(inputs[0]!); // warm the main thread's own JIT too, for the serial baseline below

    const parallelStart = Date.now();
    await Promise.all(inputs.map((inp) => pool.runSiege(inp)));
    const parallelMs = Date.now() - parallelStart;

    // Serial baseline for comparison (what scheduler.ts effectively did before this change: one battle
    // after another on a single thread).
    const serialStart = Date.now();
    for (const inp of inputs) runSiegeBattleSync(inp);
    const serialMs = Date.now() - serialStart;

    // Generous margin (this is a timing test, not a benchmark): parallel must beat serial by a clear
    // factor, not just by a hair — true cross-core parallelism should land close to ~singleMs, whereas
    // fake/serialized "parallelism" would land close to serialMs (~N× singleMs).
    expect(parallelMs).toBeLessThan(serialMs * 0.7);
  });
});
