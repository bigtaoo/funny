// The `reinforce` arrival write (combatMarch/arrival.ts), unit-tested with a fake WorldCore — same
// style as combatMarch-command-branch-gaps.test.ts, no Mongo.
//
// One line of production code is under test and both halves of it are load-bearing (2026-09-04,
// garrison regen / SLG_DESIGN §5.6):
//   - `$inc` on the STORED garrison — reinforcements are troops the owner PAID for, so they must land in
//     the refundable field rather than in the live figure a battle is resolved against;
//   - and NO `garrisonRegenAt` stamp — the checkpoint means "last settled by combat", and a reinforce is
//     not a battle. Stamping it would silently discard whatever healing the tile had accrued, so
//     reinforcing a half-healed tile would make it WEAKER than leaving it alone: the most ordinary
//     defensive play there is, punished. Nothing else in the suite would catch that — the write still
//     looks correct, the loss only shows up in `liveGarrison`'s next answer.
import { describe, expect, it, vi } from 'vitest';
import { TILE_GARRISON_REGEN_MS, tileGarrisonBaseline } from '@nw/shared';
import { ArrivalService } from '../src/combatMarch/arrival';
import { liveGarrison } from '../src/core/helpers';
import type { WorldCore } from '../src/core';
import type { SiegeService } from '../src/combatSiege';
import type { MarchDoc, PlayerWorldDoc, TileDoc } from '../src/db';

const W = 's1';
const ACC = 'acc-1';
const TILE = `${W}:5:5`;
const T = 1_700_000_000_000;
const LEVEL = 10;
/** Half the heal window already elapsed when the reinforcement lands. */
const CHECKPOINT = T - TILE_GARRISON_REGEN_MS / 2;

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ACC, fromTile: `${W}:0:0`, toTile: TILE,
    kind: 'reinforce', troops: 200, departAt: 0, arriveAt: T - 1, status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return {
    _id: TILE, worldId: W, x: 5, y: 5, type: 'territory', level: LEVEL,
    ownerId: ACC, garrison: 100, garrisonRegenAt: CHECKPOINT, rev: 0,
    ...overrides,
  } as unknown as TileDoc;
}

function build(opts: { m?: MarchDoc; target?: TileDoc | null } = {}) {
  const m = opts.m ?? march();
  const target = opts.target === undefined ? tile() : opts.target;
  const tilesUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
  const pw = { _id: `${W}:${ACC}`, worldId: W, accountId: ACC, troops: 0, rev: 0 } as unknown as PlayerWorldDoc;
  const core = {
    deps: {
      now: () => T,
      cols: {
        // A legacy (non-stepping) march: no path/stepIndex/nextStepAt, so processDueArrivals takes the
        // claim-and-settle branch straight to applyArrival.
        marches: {
          find: () => ({ limit: () => ({ toArray: async () => [m] }) }),
          findOneAndDelete: vi.fn(async (..._args: unknown[]) => m),
        },
        playerWorld: { findOne: async () => pw, updateOne: vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 })) },
        tiles: { findOne: async () => target, updateOne: tilesUpdateOne },
      },
    },
    // Only the miss branch needs these: it refunds the troops to the pool (combatShared.refundTroops),
    // which settles the player doc before writing.
    settle: () => ({}),
    pushMarch: vi.fn(async (..._args: unknown[]) => {}),
    pushTile: vi.fn(async (..._args: unknown[]) => {}),
    marchView: (doc: MarchDoc) => doc as unknown as never,
  } as unknown as WorldCore;
  return { svc: new ArrivalService(core, {} as unknown as SiegeService), tilesUpdateOne };
}

describe('reinforce arrival — the stored garrison grows, the heal clock does not move', () => {
  it('increments the STORED garrison and touches nothing else on the tile', async () => {
    const { svc, tilesUpdateOne } = build();
    expect(await svc.processDueArrivals(T)).toBe(1);
    expect(tilesUpdateOne).toHaveBeenCalledWith({ _id: TILE }, { $inc: { garrison: 200, rev: 1 } });
  });

  it('does NOT stamp garrisonRegenAt — accrued healing survives being reinforced', async () => {
    const { svc, tilesUpdateOne } = build();
    await svc.processDueArrivals(T);
    const [, update] = tilesUpdateOne.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(update.$set).toBeUndefined();
    expect(JSON.stringify(update)).not.toContain('garrisonRegenAt');

    // What that is worth, read back through the function every battle path uses: the tile the write
    // produces still carries the OLD checkpoint, so it is the 300 stored PLUS the half-baseline it had
    // already healed. Had the write stamped `t`, the same tile would stand at a flat 300 — reinforcing
    // would have thrown away 600 troops' worth of defence.
    const after = tile({ garrison: 300 });
    const restarted = tile({ garrison: 300, garrisonRegenAt: T });
    expect(liveGarrison(after, T)).toBe(300 + tileGarrisonBaseline(LEVEL) / 2);
    expect(liveGarrison(restarted, T)).toBe(300);
  });

  it('a target that changed hands mid-flight is not written to at all', async () => {
    // The miss branch above the write (captured / abandoned target). Pinned here because the write it
    // skips is the one this file is about — a reinforcement must never `$inc` a stranger's garrison.
    const { svc, tilesUpdateOne } = build({ target: tile({ ownerId: 'someone-else' }) });
    await svc.processDueArrivals(T);
    expect(tilesUpdateOne).not.toHaveBeenCalled();
  });
});
