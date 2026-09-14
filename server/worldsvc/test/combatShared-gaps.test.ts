// combatShared.ts branch-coverage gaps (2026-08-15): refundTroops's rev-conflict-retry-exhaustion
// give-up path and its "doc vanished mid-retry" bailout, plus startReturnMarch's !pw.mainBaseTile
// pre-2026-08-01 instant-refund fallback. No Mongo: both are free functions over a hand-built
// WorldCore-shaped fake (mirrors combatSiege-damage-helpers-gaps.test.ts's style for the same file family).
import { describe, expect, it, vi } from 'vitest';
import { SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { refundTroops, startNextSiegeRound, startReturnMarch } from '../src/combatShared';
import type { WorldCore } from '../src/core';
import type { PlayerWorldDoc } from '../src/db';

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: 'w1:acc1', worldId: 'w1', accountId: 'acc1', troops: 100, troopCap: 500,
    resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
    yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
    lastTickAt: 0, rev: 1,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

describe('refundTroops — rev-conflict retry exhaustion', () => {
  it('gives up (logs, returns) after MAX_ATTEMPTS(5) consecutive rev-conflicts, without throwing', async () => {
    const doc = pw();
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 0 }));
    // Every refetch just returns the same doc (rev never actually advances in this adversarial fake) —
    // forces every one of the 5 attempts to lose the race.
    const findOne = vi.fn(async (..._args: unknown[]) => doc);
    const core = {
      settle: vi.fn((..._args: unknown[]) => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      deps: { cols: { playerWorld: { updateOne, findOne } } },
    } as unknown as WorldCore;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(refundTroops(core, doc, 10, 1000)).resolves.toBeUndefined();
      expect(updateOne).toHaveBeenCalledTimes(5);
      expect(errSpy).toHaveBeenCalledWith(
        '[worldsvc] refundTroops: giving up after rev-conflict retries',
        expect.objectContaining({ docId: doc._id, troops: 10 }),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('bails out early when the doc vanishes mid-retry (refetch returns null)', async () => {
    const doc = pw();
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 0 }));
    const findOne = vi.fn(async (..._args: unknown[]) => null);
    const core = {
      settle: vi.fn((..._args: unknown[]) => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      deps: { cols: { playerWorld: { updateOne, findOne } } },
    } as unknown as WorldCore;
    await refundTroops(core, doc, 10, 1000);
    // One failed update attempt, one refetch (null) → bails before a second update attempt.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the first attempt when the write lands (no retries needed)', async () => {
    const doc = pw();
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
    const findOne = vi.fn();
    const core = {
      settle: vi.fn((..._args: unknown[]) => ({ ink: 5, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      deps: { cols: { playerWorld: { updateOne, findOne } } },
    } as unknown as WorldCore;
    await refundTroops(core, doc, 10, 1000, { ink: 3, paper: 0, graphite: 0, metal: 0, sticker: 0 } as never);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    // loot merged into settled resources, capped implicitly by RESOURCE_CAP (not exercised here).
    const setArg = updateOne.mock.calls[0]![1] as { $set: { resources: { ink: number } } };
    expect(setArg.$set.resources.ink).toBe(8);
  });
});

describe('startReturnMarch — no mainBaseTile fallback', () => {
  it('falls back to an instant refundTroops when the player has no mainBaseTile (never happens in practice, but defensive)', async () => {
    const doc = pw({ mainBaseTile: undefined });
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
    const findOnePw = vi.fn(async (..._args: unknown[]) => doc);
    const insertOne = vi.fn();
    const core = {
      settle: vi.fn((..._args: unknown[]) => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      deps: { cols: { playerWorld: { findOne: findOnePw, updateOne }, marches: { insertOne } } },
      coordX: vi.fn(),
      coordY: vi.fn(),
      pushMarch: vi.fn(),
    } as unknown as WorldCore;
    await startReturnMarch(core, {
      worldId: 'w1', ownerId: 'acc1', fromTile: 'w1:5:5', x: 5, y: 5, troops: 42,
    }, 1000);
    // refundTroops path: playerWorld.updateOne called (the refund write), no march ever inserted.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('returns immediately (no-op) when the playerWorld doc cannot be found at all', async () => {
    const findOnePw = vi.fn(async (..._args: unknown[]) => null);
    const updateOne = vi.fn();
    const core = {
      deps: { cols: { playerWorld: { findOne: findOnePw, updateOne } } },
    } as unknown as WorldCore;
    await startReturnMarch(core, {
      worldId: 'w1', ownerId: 'ghost', fromTile: 'w1:5:5', x: 5, y: 5, troops: 10,
    }, 1000);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

// startNextSiegeRound's two silent exits (2026-09-14). The round loop itself is covered end-to-end by
// base-siege.e2e.test.ts ("each round costs the team an order of stamina", "out of stamina → walks home");
// what nothing had ever executed is what happens when the dispatch does not go through. Both exits are
// unobservable in the game if they misbehave — there is no error, the siege simply stops existing — so
// they are exactly the shape the branch bar was added for.
describe('startNextSiegeRound — the exits where no round gets dispatched', () => {
  const TILE = 'w1:40:41';

  /** SiegeHoldForce for a team-dispatched, flat-troop assault with survivors and a full stamina budget. */
  const hold = { worldId: 'w1', attackerId: 'acc1', tile: TILE, attackerSurvivors: 50, teamId: 't1' };

  /** A WorldCore fake reaching only the collections these two paths touch. */
  function fakeCore(opts: { pw: PlayerWorldDoc | null; insertOne?: ReturnType<typeof vi.fn> }) {
    const insertOne = opts.insertOne ?? vi.fn(async (..._args: unknown[]) => ({ insertedId: 'm1' }));
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
    const core = {
      marchSeq: 0,
      coordX: (tile: string) => Number(tile.split(':')[1]),
      coordY: (tile: string) => Number(tile.split(':')[2]),
      settle: vi.fn(() => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      pushOrderEnded: vi.fn(),
      pushMarch: vi.fn(),
      marchView: vi.fn(),
      deps: {
        cols: {
          marches: { insertOne },
          playerWorld: { findOne: vi.fn(async (..._args: unknown[]) => opts.pw), updateOne },
        },
      },
    } as unknown as WorldCore;
    return { core, insertOne, updateOne };
  }

  it('walks the besiegers home when the round insert throws, instead of stranding them', async () => {
    // The caller has ALREADY claimed and deleted the hold document by the time this runs, so an exception
    // that escaped here would lose the force outright: no hold, no march, 50 troops gone from the game
    // with nothing pointing at where they went. The fallback is the pre-round behaviour (walk home).
    const boom = vi.fn(async (..._args: unknown[]) => { throw new Error('duplicate key'); });
    // No mainBaseTile → startReturnMarch takes its own documented instant-refund fallback, which keeps
    // this test to the two collections above rather than dragging in pathfinding.
    const { core, updateOne } = fakeCore({
      pw: pw({ _id: 'w1:acc1', teamState: { t1: { stamina: SLG_TEAM_STAMINA_MAX, staminaAt: 0 } } } as never),
      insertOne: boom,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(startNextSiegeRound(core, hold, 1000)).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(
        '[worldsvc] startNextSiegeRound failed — walking the besiegers home instead',
        expect.objectContaining({ worldId: 'w1', attackerId: 'acc1', tile: TILE }),
      );
      // The survivors came back: refundTroops credited the pool rather than the force evaporating.
      const set = updateOne.mock.calls.at(-1)![1] as { $set?: { troops?: number } };
      expect(set.$set?.troops).toBe(150); // 100 in the fixture + the 50 that were besieging
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does nothing at all when the attacker\'s world state is gone', async () => {
    // World reset under a pending siege: there is no stamina budget to read, nothing to dispatch, and no
    // home to walk to. Returning early is right — but it must be a RETURN, not a crash on `pw.teamState`,
    // because this runs inside the scheduler's settlement tick and a throw here stalls the whole batch.
    const { core, insertOne, updateOne } = fakeCore({ pw: null });
    await expect(startNextSiegeRound(core, hold, 1000)).resolves.toBeUndefined();
    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect((core as unknown as { pushOrderEnded: ReturnType<typeof vi.fn> }).pushOrderEnded).not.toHaveBeenCalled();
  });
});
