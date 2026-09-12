// 停止围攻 (2026-09-12): "is one of my teams besieging THIS cell?", asked by every tile menu that can
// offer to call the siege off (the enemy-tile menu, the wild-city panel).
//
// Kept out of the menus themselves because the answer is not a plain coordinate match. A siege hold is
// keyed on ONE cell — a main base's anchor, or the footprint cell a city march landed on — while the
// player taps whichever cell they can see the besieging token on, and a base is an indivisible 3×3
// block (ADR-025) whose eight other cells open the same menu. Matching only the exact cell would leave
// the stop button missing from eight of a base's nine tiles.
import type { SiegeHoldView } from '../../../net/WorldApiClient';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * The requester's own pending siege on this cell, or null.
 *
 * A base hold answers for its whole 3×3 footprint (the anchor is at most one cell away in each axis);
 * anything else answers for its own cell only.
 */
export function siegeHoldAt(ctx: WorldMapContext, tx: number, ty: number): SiegeHoldView | null {
  return ctx.siegeHolds.find((h) => (
    h.isBase
      ? Math.abs(h.x - tx) <= 1 && Math.abs(h.y - ty) <= 1
      : h.x === tx && h.y === ty
  )) ?? null;
}
