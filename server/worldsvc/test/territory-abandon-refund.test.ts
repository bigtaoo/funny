// `TerritoryService.abandonTile`'s refund, unit-tested with a fake WorldCore (no Mongo — the rest of
// this service's branches are covered by territory-gaps.e2e.test.ts against a real one).
//
// This is the anti-exploit half of the 2026-09-04 garrison regen (SLG_DESIGN §5.6), and the one place
// the "stored vs. live" split can be broken by a change that looks like a bug fix. Every combat path
// reads `liveGarrison(tile, t)` — stored plus the level-derived baseline heal — and it is genuinely
// tempting to make the refund agree with it, since that IS the number defending the tile. It must not:
// the heal is defence the owner never bought, so refunding it turns "occupy a high-level tile for
// GARRISON_PER_TILE → wait five minutes → 放弃" into a troop faucet that outruns training entirely.
// The refund is the only reader that deliberately takes the raw field.
import { describe, expect, it, vi } from 'vitest';
import { GARRISON_PER_TILE, TILE_GARRISON_REGEN_MS, tileGarrisonBaseline } from '@nw/shared';
import { TerritoryService } from '../src/territory';
import { liveGarrison } from '../src/core/helpers';
import type { WorldCore } from '../src/core';
import type { PlayerWorldDoc, TileDoc } from '../src/db';

const W = 's1';
const ACC = 'acc-1';
const X = 5;
const Y = 5;
const TID = `${W}:${X}:${Y}`;
const T = 1_700_000_000_000;
const LEVEL = 10; // baseline 1200 — well above the GARRISON_PER_TILE an occupy actually pays

function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return {
    _id: TID, worldId: W, x: X, y: Y, type: 'territory', level: LEVEL, ownerId: ACC,
    garrison: GARRISON_PER_TILE, garrisonRegenAt: T - TILE_GARRISON_REGEN_MS, rev: 0,
    ...overrides,
  } as unknown as TileDoc;
}

function build(target: TileDoc) {
  const pwUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const pw = { _id: `${W}:${ACC}`, worldId: W, accountId: ACC, troops: 0, buildings: {}, rev: 0 } as unknown as PlayerWorldDoc;
  const core = {
    deps: {
      now: () => T,
      cols: {
        playerWorld: { findOne: async () => pw, updateOne: pwUpdateOne },
        tiles: { findOne: async () => target, deleteOne: vi.fn(async (..._args: unknown[]) => ({})) },
        stationed: { findOneAndDelete: vi.fn(async (..._args: unknown[]) => null) },
      },
    },
    clearOccupancy: vi.fn(async (..._args: unknown[]) => {}),
    removeCover: vi.fn(async (..._args: unknown[]) => {}),
    pushOrderEnded: vi.fn(async (..._args: unknown[]) => {}),
    recomputeYield: vi.fn(async (..._args: unknown[]) => ({})),
    settleExpr: () => ({}),
    getMe: vi.fn(async (..._args: unknown[]) => ({}) as never),
  } as unknown as WorldCore;
  return { svc: new TerritoryService(core), pwUpdateOne };
}

/** The `troops` expression the abandon write built, i.e. `{ $add: ['$troops', refund] }`. */
async function refundOf(target: TileDoc): Promise<number> {
  const { svc, pwUpdateOne } = build(target);
  await svc.abandonTile(W, ACC, X, Y);
  const [, pipeline] = pwUpdateOne.mock.calls.at(-1)! as [unknown, [{ $set: { troops: { $add: [string, number] } } }]];
  return pipeline[0].$set.troops.$add[1];
}

describe('abandonTile — the refund is what the owner PAID, not what the tile fields with', () => {
  it('refunds the stored garrison even when the tile has healed far above it', async () => {
    const healed = tile();
    expect(await refundOf(healed)).toBe(GARRISON_PER_TILE);
    // The gap is the exploit's payout: this tile defends with 1200 and refunds 500.
    expect(liveGarrison(healed, T)).toBe(tileGarrisonBaseline(LEVEL));
    expect(liveGarrison(healed, T)).toBeGreaterThan(GARRISON_PER_TILE);
  });

  it('a tile stripped to nothing refunds nothing, however long it has been standing back up', async () => {
    // The same trade seen from the other side: an attacker wiped the garrison, so there is nothing left
    // to hand back — the militia that has since regrown was never in the owner's balance to begin with.
    const stripped = tile({ garrison: 0 });
    expect(await refundOf(stripped)).toBe(0);
    expect(liveGarrison(stripped, T)).toBeGreaterThan(0);
  });

  it('a reinforced surplus comes back in full — those troops WERE bought', async () => {
    // The counterpart property: reinforcements `$inc` the stored field (combatMarch/arrival.ts), so they
    // are refundable, which is the only reason reinforcing a tile is not a one-way donation.
    expect(await refundOf(tile({ garrison: 4_000 }))).toBe(4_000);
  });

  it('a tile with no garrison field at all refunds 0 rather than NaN', async () => {
    expect(await refundOf(tile({ garrison: undefined }))).toBe(0);
  });
});
