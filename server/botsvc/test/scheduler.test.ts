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
function fakeSession(
  id: number,
  hooks: Partial<Record<'onFamily' | 'onSlg', () => Promise<void>>> = {},
): FakeSession {
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
      if (hooks.onSlg) await hooks.onSlg();
    }),
    tickPve: vi.fn(async () => undefined),
    tickBattle: vi.fn(() => {
      rec.battleCalls++;
    }),
    pveDueAt: vi.fn(() => Infinity),
    pveCounters: { entered: 0, cleared: 0, lost: 0, spotChecked: 0, verified: 0 },
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

describe('Scheduler upkeep failures are counted, not swallowed', () => {
  // Both upkeep calls used to be `.catch(() => undefined)`. That is how a `tickSlg()` whose only
  // world action was rejected on EVERY call stayed invisible for months while the logs stayed clean
  // and /internal/bots/status reported a healthy fleet (see BotSession.upgradeNextBuilding).
  it('surfaces a rejected upkeep step in status() instead of discarding it', async () => {
    const pool = Array.from({ length: 3 }, (_, i) =>
      fakeSession(i, { onSlg: async () => { throw new Error('Insufficient paper'); } }),
    );
    const scheduler = new Scheduler(pool.map((p) => p.session), fakeCapacity(async () => 0), { ...OPTS, upkeepRotations: 1 });

    await scheduler.tick();

    expect(scheduler.status().upkeepErrors.slg).toBe(3);
    expect(scheduler.status().upkeepErrors.family).toBe(0);
  });

  it('keeps running the rest of the fleet when one session throws', async () => {
    const boom = fakeSession(0, { onSlg: async () => { throw new Error('boom'); } });
    const ok = fakeSession(1);
    const scheduler = new Scheduler([boom.session, ok.session], fakeCapacity(async () => 0), { ...OPTS, upkeepRotations: 1 });

    await scheduler.tick();

    expect(ok.slgCalls).toBe(1);
    expect(boom.battleCalls).toBe(1); // the chain continues past the failure, as it did before
  });

  it('logs one rolled-up warning per interval, not one per failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pool = Array.from({ length: 4 }, (_, i) =>
        fakeSession(i, { onSlg: async () => { throw new Error('Insufficient paper'); } }),
      );
      const scheduler = new Scheduler(pool.map((p) => p.session), fakeCapacity(async () => 0), { ...OPTS, upkeepRotations: 1 });

      await scheduler.tick();
      await scheduler.tick();

      const upkeepLines = warn.mock.calls.filter((c) => String(c[0]).startsWith('botsvc upkeep failures:'));
      expect(upkeepLines).toHaveLength(1);
      expect(String(upkeepLines[0]![0])).toContain('slg=4');
      expect(String(upkeepLines[0]![0])).toContain('Insufficient paper');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Scheduler upkeep with nobody online', () => {
  it('returns before slicing when the online set is empty (empty pool, nothing to rotate over)', async () => {
    // Guards the rotation arithmetic below it: chunkSize = ceil(0/rotations) = 0, so `start` and the
    // slice would be degenerate rather than wrong — but a pass over an empty fleet has nothing to do
    // at all, and this keeps a still-starting fleet from spinning up workers every tick.
    const scheduler = new Scheduler([], fakeCapacity(async () => 0), OPTS);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.status()).toEqual({ total: 0, online: 0, targetOnline: 10, effectiveTarget: 10, paused: false, upkeepErrors: { family: 0, slg: 0, pve: 0 }, pve: { entered: 0, cleared: 0, lost: 0, spotChecked: 0, verified: 0 } });
  });
});

// ── Rotation (BOTSVC_DESIGN §3.1) and PvE (§3.5) ─────────────────────────────────────────────────

/** 20:00 in Berlin (CEST): the curve's peak, so the target is exactly targetOnline. */
const BERLIN_PEAK = Date.UTC(2026, 6, 1, 18);
/** 04:00 in Berlin: the curve's floor, 12% of the peak. */
const BERLIN_NIGHT = Date.UTC(2026, 6, 1, 2);
const MIN = 60_000;

function rotating(pool: FakeSession[], over: Partial<SchedulerOptions> & { at?: { now: number } } = {}): Scheduler {
  const at = over.at ?? { now: BERLIN_PEAK };
  return new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), {
    ...OPTS,
    rotation: true,
    random: () => 0,
    now: () => at.now,
    ...over,
  });
}
const sessionOf = (f: FakeSession): any => f.session;

describe('Scheduler rotation — how many', () => {
  it('targetOnline is the evening peak; at night the fleet runs at the curve\'s share of it', async () => {
    const pool = Array.from({ length: 200 }, (_, i) => fakeSession(i));
    const scheduler = rotating(pool, { targetOnline: 100, batchSize: 200, at: { now: BERLIN_NIGHT } });
    await scheduler.tick();
    expect(scheduler.status()).toMatchObject({ targetOnline: 100, effectiveTarget: 12, online: 12 });
  });

  it('without rotation the target stays flat, whatever the hour', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => fakeSession(i));
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), { ...OPTS, now: () => BERLIN_NIGHT });
    await scheduler.tick();
    expect(scheduler.status()).toMatchObject({ effectiveTarget: 10, online: 10 });
  });
});

describe('Scheduler rotation — who', () => {
  it('logs in the bots whose PvE run is due first, earliest first, then picks at random', async () => {
    const pool = Array.from({ length: 10 }, (_, i) => fakeSession(i));
    sessionOf(pool[7]!).pveDueAt.mockReturnValue(BERLIN_PEAK - 1000);
    sessionOf(pool[3]!).pveDueAt.mockReturnValue(BERLIN_PEAK - 5000);
    sessionOf(pool[5]!).pveDueAt.mockReturnValue(BERLIN_PEAK + 1000); // not yet due
    const scheduler = rotating(pool, { targetOnline: 3, random: () => 0.999 });
    await scheduler.tick();
    const loggedIn = pool.filter((f) => sessionOf(f).login.mock.calls.length > 0).map((f) => sessionOf(f).id);
    expect(sessionOf(pool[3]!).login.mock.invocationCallOrder[0]).toBeLessThan(sessionOf(pool[7]!).login.mock.invocationCallOrder[0]);
    // The third is the random pick: 0.999 takes the last offline bot, not the pool's first.
    expect(loggedIn.sort()).toEqual([3, 7, 9]);
  });

  it('without rotation: the pool in order, the old behaviour', async () => {
    const pool = Array.from({ length: 10 }, (_, i) => fakeSession(i));
    sessionOf(pool[7]!).pveDueAt.mockReturnValue(0);
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), { ...OPTS, targetOnline: 3 });
    await scheduler.tick();
    expect(pool.filter((f) => sessionOf(f).login.mock.calls.length > 0).map((f) => sessionOf(f).id)).toEqual([0, 1, 2]);
  });
});

describe('Scheduler rotation — sessions end', () => {
  it('after their length (20 minutes at the lowest draw), from lobby_idle only, and not with a PvE run due', async () => {
    const at = { now: BERLIN_PEAK };
    const pool = Array.from({ length: 4 }, (_, i) => fakeSession(i));
    const scheduler = rotating(pool, { targetOnline: 3, at });
    await scheduler.tick();
    const [a, b, c] = pool.map(sessionOf);
    expect([a.state, b.state, c.state]).toEqual(['lobby_idle', 'lobby_idle', 'lobby_idle']);

    at.now = BERLIN_PEAK + 20 * MIN - 1;
    await scheduler.tick();
    expect(pool.map((f) => sessionOf(f).logout.mock.calls.length)).toEqual([0, 0, 0, 0]);

    at.now = BERLIN_PEAK + 20 * MIN;
    a.state = 'in_battle';
    b.pveDueAt.mockReturnValue(at.now);
    await scheduler.tick();
    expect([a.logout.mock.calls.length, b.logout.mock.calls.length, c.logout.mock.calls.length]).toEqual([0, 0, 1]);
    // And the slot it freed is refilled in the same pass.
    expect(scheduler.status().online).toBe(3);
  });

  it('without rotation a session never ends on its own', async () => {
    const at = { now: BERLIN_PEAK };
    const pool = Array.from({ length: 3 }, (_, i) => fakeSession(i));
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), { ...OPTS, targetOnline: 3, now: () => at.now });
    await scheduler.tick();
    at.now += 24 * 60 * MIN;
    await scheduler.tick();
    expect(pool.map((f) => sessionOf(f).logout.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('over target: idle sessions go first, soonest-ending first; a match is cut only if nothing else is left', async () => {
    const pool = Array.from({ length: 3 }, (_, i) => fakeSession(i));
    // No rotation: logins in pool order, one draw per session length — ends at 0.9 / 0.1 / 0.5 of the range.
    const draws = [0.9, 0.1, 0.5];
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), {
      ...OPTS, targetOnline: 3, random: () => draws.shift() ?? 0,
    });
    await scheduler.tick();
    const [a, b, c] = pool.map(sessionOf);
    b.state = 'in_battle'; // soonest-ending, but mid-match
    scheduler.setTargetOnline(2);
    await scheduler.tick();
    expect([a.logout.mock.calls.length, b.logout.mock.calls.length, c.logout.mock.calls.length]).toEqual([0, 0, 1]);
    scheduler.setTargetOnline(0);
    await scheduler.tick();
    expect([a.logout.mock.calls.length, b.logout.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('Scheduler PvE upkeep', () => {
  it('offers each session its PvE run before the ranked roll', async () => {
    const pool = [fakeSession(0)];
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), { ...OPTS, targetOnline: 1, now: () => 1234 });
    await scheduler.tick();
    const s = sessionOf(pool[0]!);
    expect(s.tickPve).toHaveBeenCalledWith(1234);
    expect(s.tickPve.mock.invocationCallOrder[0]).toBeLessThan(s.tickBattle.mock.invocationCallOrder[0]);
  });

  it('a failed run is counted as a pve upkeep error', async () => {
    const pool = [fakeSession(0)];
    sessionOf(pool[0]!).tickPve.mockRejectedValue(new Error('LEVEL_LOCKED'));
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), { ...OPTS, targetOnline: 1 });
    await scheduler.tick();
    await new Promise((r) => setImmediate(r));
    expect(scheduler.status().upkeepErrors).toEqual({ family: 0, slg: 0, pve: 1 });
  });

  it('status sums every bot\'s PvE outcomes, online or not', () => {
    const pool = [fakeSession(0), fakeSession(1)];
    sessionOf(pool[0]!).pveCounters = { entered: 3, cleared: 2, lost: 1, spotChecked: 1, verified: 1 };
    sessionOf(pool[1]!).pveCounters = { entered: 1, cleared: 0, lost: 1, spotChecked: 0, verified: 0 };
    const scheduler = new Scheduler(pool.map((f) => f.session), fakeCapacity(async () => 0), OPTS);
    expect(scheduler.status().pve).toEqual({ entered: 4, cleared: 2, lost: 2, spotChecked: 1, verified: 1 });
  });
});
