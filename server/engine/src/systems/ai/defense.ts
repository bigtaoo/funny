// Split from AISystem.ts (2026-08-10, independent function module range 6, part 5/5).
// Emergency defense (meteor/tower/blocker) and the Haste tempo tool — the two
// PlayerCommand producers that sit above the plain lane/card/meteor helpers,
// composing threatAssessment.ts/cardSelection.ts/meteorTargeting.ts.
import { GameState } from '../../GameState';
import { BuildingType, CardType, OwnerId, PlayerCommand, Side, SpellType } from '../../types';
import { AiCtx } from './types';
import { findCardIndex, pickUnitCard } from './cardSelection';
import { findMeteorTarget } from './meteorTargeting';
import { freeBuildingLane, pickLane } from './threatAssessment';

export function tryDefend(
  ctx: AiCtx,
  state: GameState,
  owner: OwnerId,
  tick: number,
  threat: number[],
): PlayerCommand | null {
  const player = state.topPlayer;

  // a) Meteor the densest cluster pressing the base (defense is never value-gated —
  //    saving the base is always worth the spell).
  if (ctx.params.useMeteor) {
    const idx = findCardIndex(player.hand.cards, player.ink, (c) =>
      c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
    if (idx !== null) {
      const target = findMeteorTarget(state, 2, /*preferNearBase*/ true, 0);
      if (target) {
        return { type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row };
      }
    }
  }

  // b) Arrow tower in the most-pressured open building lane.
  if (ctx.params.useTowers) {
    const idx = findCardIndex(player.hand.cards, player.ink, (c) =>
      c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower);
    if (idx !== null) {
      const lane = freeBuildingLane(state, threat, /*preferSafe*/ false);
      if (lane !== null) {
        return { type: 'play_card', owner, tick, handIndex: idx, col: lane };
      }
    }
  }

  // c) Block the most-threatened lane with a counter-picked (or preference-order) body.
  const lane = pickLane(ctx, threat, /*mostThreatened*/ true);
  if (lane !== null) {
    const unitIdx = pickUnitCard(state, player.hand.cards, player.ink, lane, /*forDefense*/ true, ctx.params.useCounterPicking);
    if (unitIdx !== null) {
      return { type: 'play_card', owner, tick, handIndex: unitIdx, col: lane };
    }
  }

  return null;
}

/**
 * Cast Haste on an already-advancing friendly push — a pure tempo tool, only
 * considered once emergency defense has already been ruled out for this tick.
 * Targets the column with the most friendly (Top) units (an active push worth
 * accelerating); requires at least 2 units there so it's never wasted solo.
 */
export function tryHaste(state: GameState, owner: OwnerId, tick: number): PlayerCommand | null {
  const player = state.topPlayer;
  const idx = findCardIndex(player.hand.cards, player.ink, (c) =>
    c.cardType === CardType.Spell && c.spellType === SpellType.Haste);
  if (idx === null) return null;

  const perCol = new Map<number, number>();
  for (const unit of state.board.units.values()) {
    if (unit.side !== Side.Top || unit.isDead) continue;
    perCol.set(unit.col, (perCol.get(unit.col) ?? 0) + 1);
  }
  if (perCol.size === 0) return null;

  let bestCol: number | null = null;
  let bestCount = 1; // require at least 2 friendly units to justify the spell
  for (const [col, count] of perCol) {
    if (count > bestCount) { bestCount = count; bestCol = col; }
  }
  if (bestCol === null) return null;
  return { type: 'play_card', owner, tick, handIndex: idx, col: bestCol };
}
