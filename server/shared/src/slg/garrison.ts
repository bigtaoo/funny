// SLG territory garrison replenishment (2026-09-04). An owned tile's garrison heals back up to a
// level-derived baseline after combat losses, so a territory that has already been fought over is never
// a free capture for the next attacker that walks past.
//
// **Why this exists at all.** Before this module, `TileDoc.garrison` only ever moved in two directions:
// up on a `reinforce` arrival, down on siege casualties. Nothing put it back. A tile stripped to 0 stayed
// at 0 forever, and `shouldUseCheapSiege` hands the attacker an instant, loss-free win against a 0-troop
// defender (siegeEngine.ts) — so one attack permanently converted a territory into free real estate. Neutral
// tiles never had that problem because their garrison is procedural (`npcGarrison`, never stored, never
// depleted); this brings owned tiles to the same "the land itself resists you" footing.
//
// **Stored vs. live is the whole design.** Two numbers, deliberately not the same one:
//   - **stored** `TileDoc.garrison` — troops the OWNER actually paid for (GARRISON_PER_TILE on an occupy,
//     plus every `reinforce` arrival). Refundable to the pool on 放弃 (territory.ts), reduced by casualties.
//   - **live** = {@link regenGarrison}(stored, baseline, …) — what an attacker actually fights.
// Regen only ever fills the gap between stored and the baseline; it never raises the stored field. That
// asymmetry is not an implementation detail, it is the anti-exploit: regenerated militia defends the tile
// but can never be harvested. Without it, "occupy a level-10 tile for GARRISON_PER_TILE=500 → wait 5
// minutes → 放弃 for a 1200-troop refund" is an infinite troop faucet. The settlement writes in
// combatSiege/arrival/landSiege.ts apply casualties as a **delta to the stored value**, which preserves
// the property for free — see the comment there before changing either side.
//
// **What the owner still buys by reinforcing.** Everything above the baseline. The baseline is free and
// identical for every tile of a given level, so it is a floor, not a defence: `reinforce` remains the only
// way to make one tile harder to take than another, and the only reason an attacker must bring more than
// the level-derived minimum. See design/game/SLG_DESIGN.md §5.6.
import { npcGarrison } from './siege';

/**
 * Time for a fully-stripped tile to heal back to its baseline garrison (ms). The regen is linear in this
 * window, so a partial loss refills proportionally faster (half the baseline missing → half the window).
 *
 * 5 minutes is deliberately the same figure as {@link CARD_INJURY_DURATION_MS} and
 * {@link SLG_SIEGE_DAMAGE_DELAY_MS}: an attacker whose cards were wiped is locked out for exactly as long
 * as the tile needs to stand back up, so back-to-back hits on one territory are gated by the attacker's
 * own recovery rather than by the tile staying broken. [DRAFT — tune after economy validation]
 */
export const TILE_GARRISON_REGEN_MS = 5 * 60 * 1000;

/**
 * The garrison an owned tile defends itself with for free, from its level alone.
 *
 * Deliberately `npcGarrison(level)` — the exact strength the tile had while it was neutral. Two reasons
 * over the alternatives: it is the only garrison figure in the codebase derived from the TILE rather than
 * from the history of who took it (an occupy writes GARRISON_PER_TILE, a won siege writes the attacker's
 * survivors, a settled occupation writes `contestedGarrison` — three different numbers for the same tile),
 * and it makes "what this land resists with" independent of ownership, which is what lets a defender
 * reason about a tile they have not visited.
 *
 * Note this sits BELOW GARRISON_PER_TILE (500) up to level 4 and above it from level 5 — the baseline is
 * not a promise that occupying pays for itself, only that the tile is never worth zero.
 */
export function tileGarrisonBaseline(level: number): number {
  // Coerced rather than trusted: `TileDoc.level` is typed `number` but is optional in practice (the siege
  // path reads it as `baseTile.level ?? 1`), and a missing level used to reach `npcGarrison`'s
  // `Math.max(1, undefined)` — NaN, which then propagated through the whole heal into a NaN garrison and
  // a defender that could not lose. Fall back to the same level 1 the callers already default to.
  const lv = Number.isFinite(level) ? Math.floor(level) : 1;
  return npcGarrison(Math.max(1, lv));
}

/**
 * Live garrison strength of an owned tile: `current`, healed toward `baseline` by however much of
 * {@link TILE_GARRISON_REGEN_MS} has elapsed since `regenAt`.
 *
 * Pure, and clamped in both directions:
 *   - `current >= baseline` → returned unchanged. A reinforced surplus neither regenerates (there is
 *     nothing to heal) nor decays (the owner paid for those troops).
 *   - never exceeds `baseline` on the healing path, and never goes below `current`.
 * Mirrors {@link regenDurability}'s lazy-checkpoint shape: no timer, no job — every reader recomputes from
 * the stored pair, so a tile nobody looks at costs nothing.
 */
export function regenGarrison(
  current: number,
  baseline: number,
  regenAt: number,
  now: number,
): number {
  // Non-finite inputs floor to 0 instead of poisoning the arithmetic: `NaN >= NaN` is false, so an
  // un-guarded NaN baseline would fall through to the healing branch and return NaN — a garrison that
  // compares false against everything and silently makes the defender unbeatable.
  const cur = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const base = Number.isFinite(baseline) ? Math.max(0, Math.floor(baseline)) : 0;
  if (cur >= base) return cur;
  const healed = base * (Math.max(0, now - regenAt) / TILE_GARRISON_REGEN_MS);
  return Math.min(base, Math.floor(cur + healed));
}
