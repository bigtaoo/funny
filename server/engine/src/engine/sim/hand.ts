// Hand-refresh domain — free-function form of the old HelpersMixin.drawIntoSlot (shared
// by sim/commands.ts's consumeCardSlot and this file's own tickHandRefresh) and
// LoopMixin's private tickHandRefresh (see claudedocs/server.md "engine/GameEngine").
import { CARD_REFRESH_TICKS } from '../../config';
import type { GameState } from '../../GameState';
import type { Player } from '../../Player';
import { type OwnerId, Side } from '../../types';

/** Draw one card into a hand slot and emit card_drawn. */
export function drawIntoSlot(state: GameState, player: Player, owner: OwnerId, slotIndex: number, duration: number): void {
  const card = player.drawPolicy.draw();
  player.hand.drawIntoSlot(slotIndex, card, duration);
  state.pushEvent({
    type:                'card_drawn',
    owner,
    cardType:            card.cardType,
    handIndex:           slotIndex,
    refreshDurationTicks: duration,
  });
}

export function tickHandRefresh(state: GameState, side: Side, owner: OwnerId): void {
  const player  = state.getPlayer(side);
  const expired = player.hand.tickTimers();

  for (const slotIndex of expired) {
    state.pushEvent({ type: 'card_expired', owner, handIndex: slotIndex });
    drawIntoSlot(state, player, owner, slotIndex, CARD_REFRESH_TICKS);
  }
}
