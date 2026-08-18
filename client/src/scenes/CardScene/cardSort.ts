// Roster-grid ordering + the injury countdown string, split out of ./core.ts (2026-08-18) so the
// shared-state root stays under the 500-line convention while the batch-prep hook lands there.
// Both are pure functions of their arguments with no CardSceneCore dependency (form ① per
// claudedocs/client-modules.md) — core.ts re-exports them, so importers are unchanged.
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, cardPower } from '../../game/meta/cardDefs';

const DEF_ORDER = Object.keys(CARD_DEFS);

/**
 * Sort cards for the roster grid: cards deployed to an SLG team come first, the rest after (2026-08-01
 * — deployed cards used to scatter across the level-grouped grid instead of reading as "my current
 * squad" at a glance). Within each group, highest combat power first (the stat that matters when
 * picking who to send out); ties fall back to level desc, then hero (CARD_DEFS declaration order,
 * keeps duplicate instances of one hero together), then id for stability.
 *
 * `cardState` is the SLG per-card state (teamId) — omit it, or pass one where a card has no entry, to
 * treat that card as not deployed (e.g. outside SLG, or before the async SLG fetch resolves).
 */
export function sortCards(
  cards: CardInstance[],
  equipInv: SaveData['equipmentInv'],
  cardState?: Record<string, CardSLGState>,
): CardInstance[] {
  return [...cards].sort((a, b) => {
    const ad = !!cardState?.[a.id]?.teamId;
    const bd = !!cardState?.[b.id]?.teamId;
    if (ad !== bd) return ad ? -1 : 1;
    const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
    if (pd !== 0) return pd;
    if (b.level !== a.level) return b.level - a.level;
    const gd = DEF_ORDER.indexOf(a.defId) - DEF_ORDER.indexOf(b.defId);
    if (gd !== 0) return gd;
    return a.id < b.id ? -1 : 1;
  });
}

/** Human-readable countdown string for injuredUntil timestamp. */
export function injuryCountdown(injuredUntil: number, now: number): string {
  const secsLeft = Math.max(0, Math.ceil((injuredUntil - now) / 1000));
  return secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
}
