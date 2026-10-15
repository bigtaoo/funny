// The free phase's idle prompt (ONBOARDING_DESIGN §17.7): what to point a player at who has stopped
// playing cards while enemies walk at their base. Pure board/hand lookup — TutorialDirector owns the
// timing and reuses its beat prompt (frame, lane light, ghost hand) to show it.
import { CardType, type GameState } from '../../game';
import type { BeatKind, BeatSpec } from './beats';
import { enemyUnits } from './geometry';

/** Cheapest way to stop the nearest enemy, in order: a unit in its lane, a building there, a spell on it. */
const KIND_ORDER: readonly [CardType, BeatKind][] = [
  [CardType.Unit, 'unit'], [CardType.Building, 'building'], [CardType.Spell, 'spell'],
];

/**
 * A one-off "beat" for the idle prompt: an affordable card in hand aimed at the lane of the enemy
 * closest to the player's base, or null when there is nothing to stop or nothing to play it with —
 * the prompt never freezes the fight on a card the player cannot afford.
 */
export function pickIdleHint(state: GameState): BeatSpec | null {
  const enemies = enemyUnits(state);
  if (enemies.length === 0) return null;
  // The local player is the bottom side, whose base sits below row 0.
  const nearest = enemies.reduce((a, b) => (b.row < a.row ? b : a));
  const ink = state.bottomPlayer.ink;
  for (const [type, kind] of KIND_ORDER) {
    const slot = state.bottomPlayer.hand.slots.find((s) => s && s.card.cardType === type && s.card.cost <= ink);
    if (slot) return { cardId: slot.card.id, kind, col: nearest.col, setupTick: 0 };
  }
  return null;
}
