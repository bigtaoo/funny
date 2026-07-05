// Cross-domain helpers shared by more than one engine mixin (drawIntoSlot is used by both
// CommandsMixin's consumeCardSlot and LoopMixin's tickHandRefresh; accumulateBuildingSurvival
// is used by LoopMixin's step()). Applied first in the chain (see ../GameEngine.ts) so every
// later mixin can call these via `this`.
import type { Constructor, GameEngineBaseCtor } from './base';
import type { OwnerId } from '../types';
import type { Player } from '../Player';

/**
 * Shape exposed to later mixins in the chain (TypeScript checks a generic mixin's body only
 * against its declared `TBase` constraint, not the actual call-site argument — so any mixin
 * that calls `this.drawIntoSlot`/`this.accumulateBuildingSurvival` must widen its own `TBase`
 * to `... & Constructor<HelpersHandlers>`).
 */
export interface HelpersHandlers {
  drawIntoSlot(player: Player, owner: OwnerId, slotIndex: number, duration: number): void;
  accumulateBuildingSurvival(): void;
}

export function HelpersMixin<TBase extends GameEngineBaseCtor>(Base: TBase): TBase & Constructor<HelpersHandlers> {
  return class extends Base {
    // ─── Helpers ──────────────────────────────────────────────────────────────

    /** Draw one card into a hand slot and emit card_drawn. */
    drawIntoSlot(player: Player, owner: OwnerId, slotIndex: number, duration: number): void {
      const card = player.drawPolicy.draw();
      player.hand.drawIntoSlot(slotIndex, card, duration);
      this.state.pushEvent({
        type:                'card_drawn',
        owner,
        cardType:            card.cardType,
        handIndex:           slotIndex,
        refreshDurationTicks: duration,
      });
    }

    accumulateBuildingSurvival(): void {
      for (const building of this.state.board.buildings.values()) {
        if (!building.isDead) {
          const owner = this.state.ownerOf(building.side);
          this.state.stats[owner].buildingSurvivalTicks++;
        }
      }
    }
  };
}
