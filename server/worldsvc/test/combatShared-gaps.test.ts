// combatShared.ts branch-coverage gaps (2026-08-15): refundTroops's rev-conflict-retry-exhaustion
// give-up path and its "doc vanished mid-retry" bailout, plus startReturnMarch's !pw.mainBaseTile
// pre-2026-08-01 instant-refund fallback. No Mongo: both are free functions over a hand-built
// WorldCore-shaped fake (mirrors combatSiege-damage-helpers-gaps.test.ts's style for the same file family).
import { describe, expect, it, vi } from 'vitest';
import { refundTroops, startReturnMarch } from '../src/combatShared';
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
    const updateOne = vi.fn(async () => ({ matchedCount: 0 }));
    // Every refetch just returns the same doc (rev never actually advances in this adversarial fake) —
    // forces every one of the 5 attempts to lose the race.
    const findOne = vi.fn(async () => doc);
    const core = {
      settle: vi.fn(() => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
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
    const updateOne = vi.fn(async () => ({ matchedCount: 0 }));
    const findOne = vi.fn(async () => null);
    const core = {
      settle: vi.fn(() => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
      deps: { cols: { playerWorld: { updateOne, findOne } } },
    } as unknown as WorldCore;
    await refundTroops(core, doc, 10, 1000);
    // One failed update attempt, one refetch (null) → bails before a second update attempt.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the first attempt when the write lands (no retries needed)', async () => {
    const doc = pw();
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const findOne = vi.fn();
    const core = {
      settle: vi.fn(() => ({ ink: 5, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
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
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const findOnePw = vi.fn(async () => doc);
    const insertOne = vi.fn();
    const core = {
      settle: vi.fn(() => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
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
    const findOnePw = vi.fn(async () => null);
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
