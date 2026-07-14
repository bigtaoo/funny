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
