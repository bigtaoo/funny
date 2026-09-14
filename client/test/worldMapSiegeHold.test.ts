// siegeHoldAt — "is one of my teams besieging THIS cell?", the question every tile menu that can offer
// 停止围攻 asks (WorldMapInput.ts's enemy-tile branch, WorldMapInput/cityPanel.ts).
//
// The module shipped with the siege feature on 2026-09-12 and had no test until 2026-09-14. It was
// inside the coverage gate the whole time (`src/scenes/worldmap/logic/**` is a directory include) at
// 0% lines, which the package-level 90% bar could not see: the client was at 99.66%, so seven
// uncovered lines moved it by 0.02pp. That is the gap this file closes, and the reason the interesting
// cases below are about the 3x3 footprint rather than the plain coordinate match.
//
// Why the footprint rule is the whole point of the module: a hold is keyed on ONE cell — a main base's
// anchor, or the footprint cell a city march landed on — while the player taps whichever cell they can
// see the besieging token on, and a base is an indivisible 3x3 block (ADR-025) whose eight other cells
// open the same menu. Collapse this back to `h.x === tx && h.y === ty` and the stop button silently
// disappears from eight of a base's nine tiles: nothing throws, the siege still runs, the player just
// cannot call it off from the tile they are looking at.

import { describe, it, expect } from 'vitest';
import { siegeHoldAt } from '../src/scenes/worldmap/logic/siegeHold';
import type { SiegeHoldView } from '../src/net/WorldApiClient';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';

const ANCHOR = { x: 40, y: 41 };

function hold(over: Partial<SiegeHoldView> = {}): SiegeHoldView {
  return {
    siegeId: 's1',
    tile: `w1:${ANCHOR.x}:${ANCHOR.y}`,
    x: ANCHOR.x,
    y: ANCHOR.y,
    dueAt: 1_000_000,
    damage: 120,
    isBase: true,
    teamId: 't1',
    ...over,
  } as SiegeHoldView;
}

/** Only `siegeHolds` is read, so the context is that one field — cast the way the call sites hand it over. */
function ctxWith(...holds: SiegeHoldView[]): WorldMapContext {
  return { siegeHolds: holds } as unknown as WorldMapContext;
}

describe('siegeHoldAt', () => {
  it('answers for every cell of a besieged base, not just its anchor', () => {
    const ctx = ctxWith(hold({ isBase: true }));
    // All nine cells of the 3x3 block open the same enemy-tile menu, so all nine must offer the stop
    // button. This is the case a plain coordinate match gets wrong eight times out of nine.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const at = siegeHoldAt(ctx, ANCHOR.x + dx, ANCHOR.y + dy);
        expect(at, `offset ${dx},${dy}`).not.toBeNull();
        expect(at!.siegeId).toBe('s1');
      }
    }
  });

  it('stops at the footprint edge — the cell one step outside the block is not besieged', () => {
    const ctx = ctxWith(hold({ isBase: true }));
    // The upper bound matters as much as the lower one: widening the rule would put a stop button on a
    // neighbouring tile that has its own, unrelated menu.
    expect(siegeHoldAt(ctx, ANCHOR.x + 2, ANCHOR.y)).toBeNull();
    expect(siegeHoldAt(ctx, ANCHOR.x, ANCHOR.y - 2)).toBeNull();
    expect(siegeHoldAt(ctx, ANCHOR.x + 2, ANCHOR.y + 2)).toBeNull();
  });

  it('answers for its own cell only when the hold is not a base', () => {
    // A city hold is keyed on the footprint cell the march actually landed on, so it does NOT get the
    // base's neighbour tolerance — the adjacent cells of a multi-cell city are their own tiles here.
    const ctx = ctxWith(hold({ isBase: false }));
    expect(siegeHoldAt(ctx, ANCHOR.x, ANCHOR.y)).not.toBeNull();
    expect(siegeHoldAt(ctx, ANCHOR.x + 1, ANCHOR.y)).toBeNull();
    expect(siegeHoldAt(ctx, ANCHOR.x, ANCHOR.y + 1)).toBeNull();
  });

  it('returns null when nothing of mine is besieging anything', () => {
    expect(siegeHoldAt(ctxWith(), ANCHOR.x, ANCHOR.y)).toBeNull();
  });

  it('picks the hold covering the tapped cell, not merely the first one held', () => {
    // Two of my teams besieging two different bases: the menu must offer to stop the one the player is
    // looking at. `find` over an unfiltered list would hand back whichever siege started first.
    const far = hold({ siegeId: 's-far', x: 10, y: 10, tile: 'w1:10:10', teamId: 't2' });
    const near = hold({ siegeId: 's-near', teamId: 't3' });
    const ctx = ctxWith(far, near);
    expect(siegeHoldAt(ctx, ANCHOR.x + 1, ANCHOR.y + 1)!.teamId).toBe('t3');
    expect(siegeHoldAt(ctx, 10, 11)!.teamId).toBe('t2');
  });

  it('hands back the whole hold, because the menu needs more than a yes/no', () => {
    // The caller reads `teamId` for doStopHold and `dueAt` for the countdown line above the button;
    // a boolean-shaped answer would have been enough for the button and wrong for the line.
    const at = siegeHoldAt(ctxWith(hold({ dueAt: 1_234_000, teamId: 't4' })), ANCHOR.x - 1, ANCHOR.y);
    expect(at).toMatchObject({ teamId: 't4', dueAt: 1_234_000, siegeId: 's1' });
  });
});
