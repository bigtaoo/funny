// Scheduler tick hardening (BOTSVC_DESIGN §3.1): the process fires tick() on a fixed interval
// regardless of whether the previous pass finished, and a pass touches every online session — so a
// pass must (a) never overlap itself and (b) run per-session upkeep at bounded, not serial, not
// unbounded, concurrency. Both were direct contributors to the mid-match heartbeat drops seen in the
// 2026-07-14 load tests.
import { describe, it, expect, vi } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../src/scheduler';
import type { BotSession } from '../src/bot';
import type { CapacityClient } from '../src/capacityClient';

const OPTS: SchedulerOptions = {
  targetOnline: 10,
  shedStartAt: 2500,
  shedFullAt: 2800,
  batchSize: 10,
  upkeepConcurrency: 3,
  upkeepRotations: 1,
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface FakeSession {
  session: BotSession;
  familyCalls: number;
  slgCalls: number;
  battleCalls: number;
}

/** Minimal stand-in exposing only the surface Scheduler drives; login() flips it online. */
function fakeSession(id: number, hooks: Partial<Record<'onFamily', () => Promise<void>>> = {}): FakeSession {
  const rec: FakeSession = { session: null as unknown as BotSession, familyCalls: 0, slgCalls: 0, battleCalls: 0 };
  const obj = {
    id,
    state: 'offline' as string,
    login: vi.fn(async () => {
      obj.state = 'lobby_idle';
    }),
    logout: vi.fn(() => {
      obj.state = 'offline';
    }),
    tickFamily: vi.fn(async () => {
      rec.familyCalls++;
      if (hooks.onFamily) await hooks.onFamily();
    }),
    tickSlg: vi.fn(async () => {
      rec.slgCalls++;
    }),
    tickBattle: vi.fn(() => {
      rec.battleCalls++;
    }),
  };
  rec.session = obj as unknown as BotSession;
  return rec;
}

function fakeCapacity(onlineCount: () => Promise<number>): CapacityClient {
  return { onlineCount } as unknown as CapacityClient;
}

describe('Scheduler re-entrancy guard', () => {
  it('skips a pass while the previous one is still running (no overlapping ticks)', async () => {
    const gate = deferred<number>();
    const onlineCount = vi.fn(() => gate.promise);
    const pool = [fakeSession(0)];
    const scheduler = new Scheduler(
      pool.map((f) => f.session),
      fakeCapacity(onlineCount),
      OPTS,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = scheduler.tick(); // enters, blocks awaiting onlineCount
    await Promise.resolve();
    const second = scheduler.tick(); // guard should short-circuit this immediately
    await second;

    expect(onlineCount).toHaveBeenCalledTimes(1); // second pass never got past the guard
    expect(warn).toHaveBeenCalledOnce();

    gate.resolve(10);
    await first;
    warn.mockRestore();
  });

  it('runs again normally once the previous pass has finished', async () => {
    const onlineCount = vi.fn(async () => 10);
    const pool = [fakeSession(0)];
    const scheduler = new Scheduler(
      pool.map((f) => f.session),
      fakeCapacity(onlineCount),
      OPTS,
    );

    await scheduler.tick();
    await scheduler.tick();

    expect(onlineCount).toHaveBeenCalledTimes(2);
  });
});

describe('Scheduler bounded-concurrency upkeep', () => {
  it('never runs more than upkeepConcurrency upkeep chains at once, but does parallelize', async () => {
    let inFlight = 0;
    let peak = 0;
    const onFamily = async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    const pool = Array.from({ length: 10 }, (_, i) => fakeSession(i, { onFamily }));
    const scheduler = new Scheduler(
      pool.map((f) => f.session),
      fakeCapacity(async () => 10),
      OPTS,
    );

    await scheduler.tick();

    expect(peak).toBe(OPTS.upkeepConcurrency); // exactly the cap — proves both the ceiling and real parallelism
    for (const f of pool) {
      expect(f.familyCalls).toBe(1);
      expect(f.slgCalls).toBe(1);
      expect(f.battleCalls).toBe(1);
    }
  });

  it('keeps each session\'s family -> slg -> battle order intact', async () => {
    const order: string[] = [];
    const pool = Array.from({ length: 4 }, (_, i) => {
      const f = fakeSession(i, { onFamily: async () => void order.push(`f${i}`) });
      const s = f.session as unknown as { tickSlg: () => Promise<void>; tickBattle: () => void };
      const origSlg = s.tickSlg;
      s.tickSlg = async () => {
        order.push(`s${i}`);
        await origSlg();
      };
      const origBattle = s.tickBattle;
      s.tickBattle = () => {
        order.push(`b${i}`);
        origBattle();
      };
      return f;
    });
    const scheduler = new Scheduler(
      pool.map((f) => f.session),
      fakeCapacity(async () => 10),
      OPTS,
    );

    await scheduler.tick();

    for (let i = 0; i < 4; i++) {
      expect(order.indexOf(`f${i}`)).toBeLessThan(order.indexOf(`s${i}`));
      expect(order.indexOf(`s${i}`)).toBeLessThan(order.indexOf(`b${i}`));
    }
  });
});

describe('Scheduler pause/resume', () => {
  it('while paused, tick() logs everyone out (drainAll) instead of the normal spawn/upkeep pass', async () => {
    const pool = Array.from({ length: 3 }, (_, i) => fakeSession(i));
    const onlineCount = vi.fn(async () => 10);
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(onlineCount), OPTS);

    await scheduler.tick(); // spawns up to targetOnline first, so there's something to drain
    expect(scheduler.status().online).toBe(3);

    scheduler.pause();
    await scheduler.tick();

    expect(scheduler.status()).toMatchObject({ online: 0, paused: true });
    expect(pool.every((f) => (f.session as unknown as { state: string }).state === 'offline')).toBe(true);
    // The capacity/spawn/upkeep path is skipped entirely on the paused tick — onlineCount (called once
    // by the first, unpaused tick above) is never called again.
    expect(onlineCount).toHaveBeenCalledTimes(1);
  });

  it('resume() restores the normal tick path', async () => {
    const pool = [fakeSession(0)];
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 10), OPTS);
    scheduler.pause();
    await scheduler.tick();
    expect(scheduler.status().paused).toBe(true);

    scheduler.resume();
    await scheduler.tick();

    expect(scheduler.status()).toMatchObject({ online: 1, paused: false });
    expect(pool[0]!.familyCalls).toBe(1);
  });
});

describe('Scheduler capacity-signal failure', () => {
  it('falls back to the undiminished targetOnline (no shedding) when the capacity signal throws', async () => {
    const pool = Array.from({ length: 5 }, (_, i) => fakeSession(i));
    const onlineCount = vi.fn(async () => { throw new Error('gateway unreachable'); });
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(onlineCount), OPTS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await scheduler.tick();

    expect(scheduler.status().effectiveTarget).toBe(OPTS.targetOnline);
    expect(scheduler.status().online).toBe(pool.length); // spawned up to the full target, no shedding
    warn.mockRestore();
  });

  it('warns only once across repeated failing ticks (capacityWarned one-shot flag)', async () => {
    const pool = [fakeSession(0)];
    const onlineCount = vi.fn(async () => { throw new Error('gateway unreachable'); });
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(onlineCount), OPTS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('Scheduler despawnDownTo', () => {
  it('logs sessions out down to a lowered target, capped at batchSize per tick', async () => {
    const pool = Array.from({ length: 6 }, (_, i) => fakeSession(i));
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 10), { ...OPTS, targetOnline: 6, batchSize: 10 });
    await scheduler.tick(); // spawn all 6 online

    scheduler.setTargetOnline(2);
    await scheduler.tick(); // despawn 4, down to 2

    expect(scheduler.status().online).toBe(2);
    const loggedOut = pool.filter((f) => (f.session as unknown as { state: string }).state === 'offline');
    expect(loggedOut).toHaveLength(4);
  });

  it('despawn itself is capped at batchSize per tick, even if further above target', async () => {
    const pool = Array.from({ length: 6 }, (_, i) => fakeSession(i));
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 10), { ...OPTS, targetOnline: 6, batchSize: 2 });
    // spawnUpTo is capped by the same batchSize, so it takes 3 ticks to bring all 6 online.
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.status().online).toBe(6);

    scheduler.setTargetOnline(0);
    await scheduler.tick(); // only 2 despawned this pass (batchSize cap)

    expect(scheduler.status().online).toBe(4);
  });
});

describe('Scheduler upkeep rotation', () => {
  it('spreads upkeep across upkeepRotations ticks instead of touching everyone every tick', async () => {
    const pool = Array.from({ length: 9 }, (_, i) => fakeSession(i));
    const scheduler = new Scheduler(
      pool.map((f) => f.session),
      fakeCapacity(async () => 10),
      { ...OPTS, upkeepRotations: 3 },
    );

    await scheduler.tick(); // slice 1: sessions 0-2
    await scheduler.tick(); // slice 2: sessions 3-5
    await scheduler.tick(); // slice 3: sessions 6-8
    for (const f of pool) {
      expect(f.familyCalls).toBe(1);
      expect(f.slgCalls).toBe(1);
      expect(f.battleCalls).toBe(1);
    }

    await scheduler.tick(); // wraps back to slice 1
    expect(pool[0]!.familyCalls).toBe(2);
    expect(pool[8]!.familyCalls).toBe(1); // untouched this round
  });
});

describe('Scheduler upkeep with nobody online', () => {
  it('returns before slicing when the online set is empty (empty pool, nothing to rotate over)', async () => {
    // Guards the rotation arithmetic below it: chunkSize = ceil(0/rotations) = 0, so `start` and the
    // slice would be degenerate rather than wrong — but a pass over an empty fleet has nothing to do
    // at all, and this keeps a still-starting fleet from spinning up workers every tick.
    const scheduler = new Scheduler([], fakeCapacity(async () => 0), OPTS);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.status()).toEqual({ total: 0, online: 0, targetOnline: 10, effectiveTarget: 10, paused: false });
  });
});
