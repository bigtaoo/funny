// Unit tests for SiegeWorkerPool (server-logic-audit-2026-07-29, item 3 — siegeEngine moved off the main
// thread). No Mongo needed: these exercise the pool in isolation, not the worldsvc business logic around it
// (that's covered by the existing siege/base-siege/stronghold/passage/field-encounter e2e suites, which all
// still pass unchanged now that `runSiegeBattle` is async — see siegeEngine.ts).
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SiegeWorkerPool, defaultSiegeWorkerPoolSize } from '../src/siegeWorkerPool';
import { runSiegeBattleSync, synthesizeArmy, SIEGE_SYNTH_ARMY_MAX_TROOPS, type SiegeBattleInput } from '../src/siegeEngine';

const CRASH_WORKER = path.join(__dirname, 'fixtures', 'crashWorker.ts');
const HANG_WORKER = path.join(__dirname, 'fixtures', 'hangWorker.ts');
const SLOW_THEN_HANG_WORKER = path.join(__dirname, 'fixtures', 'slowThenHangWorker.ts');

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

const pools: SiegeWorkerPool[] = [];
function makePool(...args: ConstructorParameters<typeof SiegeWorkerPool>): SiegeWorkerPool {
  const pool = new SiegeWorkerPool(...args);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe('defaultSiegeWorkerPoolSize', () => {
  it('is at least 1 and at most cpus-1', () => {
    const n = defaultSiegeWorkerPoolSize();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(Math.max(1, os.cpus().length - 1));
  });
});

describe('SiegeWorkerPool basic scheduling', () => {
  it('submit → resolves with the exact same result runSiegeBattleSync produces for the same input (determinism unaffected by moving execution to a worker)', async () => {
    const pool = makePool(2);
    const input = bigEvenBattle(1234);
    const expected = runSiegeBattleSync(input);
    const actual = await pool.submit(input);
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
    const results = await Promise.all(inputs.map((inp) => pool.submit(inp)));
    expect(results).toHaveLength(12);
    // Cross-check every result against the pure sync function for the same input.
    inputs.forEach((inp, i) => {
      expect(results[i]).toEqual(runSiegeBattleSync(inp));
    });
  });

  it('bad input (invalid formation) rejects the submit() promise rather than hanging or crashing the worker', async () => {
    const pool = makePool(1);
    const badInput: SiegeBattleInput = {
      attackerArmy: [{ unitType: synthesizeArmy(60, 'attacker')[0]!.unitType, col: -999, row: -999, initialHp: 60 }],
      defenderConfig: null,
      tileLevel: 1,
      seed: 1,
    };
    await expect(pool.submit(badInput)).rejects.toThrow();
    // The worker itself survived (caught the error internally, per siegeWorker.ts) — a follow-up good task
    // on the same pool still succeeds, proving the worker wasn't torn down by the bad input.
    const good = bigEvenBattle(2);
    await expect(pool.submit(good)).resolves.toEqual(runSiegeBattleSync(good));
  });
});

describe('SiegeWorkerPool crash self-heal', () => {
  it('a worker that hard-crashes mid-task rejects that task and the pool respawns a replacement (size unchanged)', async () => {
    const pool = makePool(1, 30_000, CRASH_WORKER);
    expect(pool.size).toBe(1);

    await expect(pool.submit(bigEvenBattle(1))).rejects.toThrow(/crashed/);
    // Pool self-healed: still exactly 1 worker (the crashed one was replaced, not just removed).
    expect(pool.size).toBe(1);

    // Self-heal is not a one-shot fluke: the pool survives repeated crashes (every fresh crashWorker
    // instance crashes again on its first message).
    await expect(pool.submit(bigEvenBattle(2))).rejects.toThrow(/crashed/);
    expect(pool.size).toBe(1);
    await expect(pool.submit(bigEvenBattle(3))).rejects.toThrow(/crashed/);
    expect(pool.size).toBe(1);
  });

  it('a crash only rejects the task that was in flight on that worker; concurrent tasks on other workers are unaffected', async () => {
    const pool = makePool(2, 30_000, CRASH_WORKER);
    // Both workers crash immediately on their first message, but each task's own rejection is independent.
    const results = await Promise.allSettled([pool.submit(bigEvenBattle(1)), pool.submit(bigEvenBattle(2))]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(pool.size).toBe(2); // both replaced
  });
});

describe('SiegeWorkerPool task timeout', () => {
  it('a hung worker (never responds) is terminated and its task rejects after the configured timeout; pool size is restored', async () => {
    const pool = makePool(1, 200, HANG_WORKER); // 200ms timeout — short for test speed
    const start = Date.now();
    await expect(pool.submit(bigEvenBattle(1))).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(190); // allow a few ms of scheduling slop
    expect(pool.size).toBe(1); // hung worker was terminated + replaced
  });
});

describe('SiegeWorkerPool task timeout (dispatch-time arming regression)', () => {
  it('a task queued behind several quick-but-non-instant tasks past taskTimeoutMs still gets full hang protection once it is actually dispatched', async () => {
    // Single worker so tasks run strictly one at a time. The fixture answers each of the first 5 messages
    // after ~150ms and hangs on the 6th. That 6th task sits in `queue` for ~750ms (5 × 150ms) before a
    // worker is ever free for it — well past the 400ms per-task timeout — then hangs once actually
    // dispatched. Both the per-message delay and the timeout are generous relative to each other so that
    // worker-thread cold-start jitter on the very first message can't by itself trip the timeout.
    //
    // Before the fix, the 6th task's hang-guard timer was armed at submit() time (t≈0) and fired at t≈400ms
    // while the task was still queued — a documented no-op (queued tasks aren't in `pending` yet) — leaving
    // nothing to ever re-arm it once the task was later dispatched onto a worker that then hangs on it
    // forever (test would time out rather than reject). The fix arms the timer only in `dispatch()`, so the
    // 6th task gets its own full 400ms of hang protection starting from when it actually begins running.
    const pool = makePool(1, 400, SLOW_THEN_HANG_WORKER);
    const inputs = Array.from({ length: 6 }, (_, i) => bigEvenBattle(i));
    const submissions = inputs.map((inp) => pool.submit(inp));

    await expect(Promise.all(submissions.slice(0, 5))).resolves.toBeDefined();
    await expect(submissions[5]).rejects.toThrow(/timed out/);
    expect(pool.size).toBe(1); // hung worker detected + replaced
  });
});

describe('SiegeWorkerPool queueing under load', () => {
  it('more in-flight submissions than workers still all resolve (queued, not rejected/dropped)', async () => {
    const pool = makePool(2);
    const inputs = Array.from({ length: 6 }, (_, i) => bigEvenBattle(100 + i));
    const results = await Promise.all(inputs.map((inp) => pool.submit(inp)));
    expect(results).toHaveLength(6);
    inputs.forEach((inp, i) => expect(results[i]).toEqual(runSiegeBattleSync(inp)));
  });
});

describe('SiegeWorkerPool close()', () => {
  it('rejects in-flight and queued tasks, and rejects any further submit() calls', async () => {
    const pool = new SiegeWorkerPool(1); // not auto-closed by afterEach — closed manually below
    const queued = pool.submit(bigEvenBattle(1));
    const closeP = pool.close();
    await expect(queued).rejects.toThrow(/closed/);
    await closeP;
    await expect(pool.submit(bigEvenBattle(2))).rejects.toThrow(/closed/);
  });
});

describe('SiegeWorkerPool wall-clock parallelism (the "free lunch" the audit called out: scheduler.ts\'s Promise.allSettled over concurrent siege battles used to serialize on one thread; the pool actually spreads them across cores)', () => {
  it('N concurrent heavy battles on an N-worker pool complete in well under N× a single battle\'s time (real cross-core parallelism, not queued serial execution)', async () => {
    const N = 6;
    const pool = makePool(N);
    const inputs = Array.from({ length: N }, (_, i) => bigEvenBattle(1000 + i));

    // Warm up every worker first (module load / tsx transpile / JIT is a one-time per-worker cost that a
    // real long-lived worldsvc process pays once at boot, not per battle — excluding it here is what makes
    // this a fair "steady state" comparison instead of measuring pool cold-start).
    const warmup = Array.from({ length: N }, (_, i) => bigEvenBattle(9000 + i));
    await Promise.all(warmup.map((inp) => pool.submit(inp)));
    runSiegeBattleSync(inputs[0]!); // warm the main thread's own JIT too, for the serial baseline below

    const parallelStart = Date.now();
    await Promise.all(inputs.map((inp) => pool.submit(inp)));
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
