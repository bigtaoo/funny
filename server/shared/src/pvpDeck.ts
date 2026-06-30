// PvP deck unlock logic and validation (PVP_LOADOUT_DESIGN §3–4).
// Authority: unlock thresholds match RANK_TIERS in ladder.ts; base card list matches CARD_DEFINITIONS in engine config.ts.
// Used by gateway (deck validation on queue/create) and client (display locked/unlocked state).

/** Deck size fixed at 10 for the initial release (PVP_LOADOUT §4). */
export const PVP_DECK_SIZE = 10;

/** Cards available to every player regardless of rank. Exactly 10 — new players are forced to use the full base set. */
export const PVP_BASE_CARDS: readonly string[] = [
  'infantry', 'shieldbearer', 'archer', 'max', 'lena', 'mara',
  'barracks', 'tower',
  'haste', 'meteor',
];

/** Building-type cards (deck must include ≥1). */
export const PVP_BUILDING_CARDS: readonly string[] = ['barracks', 'tower'];

/** Spell-type cards (deck must include ≥1). */
export const PVP_SPELL_CARDS: readonly string[] = ['haste', 'meteor'];

/**
 * ELO-gated unlock tiers (§3). Unlock check uses seasonPeakElo (never drops, even after soft reset).
 * Tiers are checked in order; all tiers whose minElo ≤ seasonPeakElo are unlocked.
 */
export const PVP_UNLOCK_TIERS: ReadonlyArray<{ minElo: number; cards: readonly string[] }> = [
  { minElo: 1500, cards: ['runner', 'ironclad'] },       // diamond
  { minElo: 2100, cards: ['berserker', 'splitter'] },    // grandmaster
  { minElo: 2400, cards: ['harpy', 'medic'] },           // king
];

/** All card ids a player may include in their deck given their current seasonPeakElo. */
export function getPvpUnlockedCards(seasonPeakElo: number): string[] {
  const cards: string[] = [...PVP_BASE_CARDS];
  for (const tier of PVP_UNLOCK_TIERS) {
    if (seasonPeakElo >= tier.minElo) cards.push(...tier.cards);
  }
  return cards;
}

/**
 * Validate a submitted deck.
 * Rules (§4): exactly PVP_DECK_SIZE cards; each card in the unlocked set; no duplicates; ≥1 building; ≥1 spell.
 */
export function validatePvpDeck(deck: string[], seasonPeakElo: number): { valid: boolean; error?: string } {
  if (deck.length !== PVP_DECK_SIZE) {
    return { valid: false, error: `deck must have exactly ${PVP_DECK_SIZE} cards, got ${deck.length}` };
  }
  const unlocked = new Set(getPvpUnlockedCards(seasonPeakElo));
  const seen = new Set<string>();
  for (const card of deck) {
    if (!unlocked.has(card)) return { valid: false, error: `card "${card}" not in unlocked set` };
    if (seen.has(card)) return { valid: false, error: `duplicate card "${card}"` };
    seen.add(card);
  }
  if (!deck.some((c) => PVP_BUILDING_CARDS.includes(c))) {
    return { valid: false, error: 'deck must include at least 1 building (barracks or tower)' };
  }
  if (!deck.some((c) => PVP_SPELL_CARDS.includes(c))) {
    return { valid: false, error: 'deck must include at least 1 spell (haste or meteor)' };
  }
  return { valid: true };
}

/** Default deck used when a player submits no deck or an invalid deck (all 10 base cards). */
export function defaultPvpDeck(): string[] {
  return [...PVP_BASE_CARDS];
}
