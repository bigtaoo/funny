// Client-side PvP loadout constants (P3, PVP_LOADOUT_DESIGN §3–4).
// Mirrors server/shared/src/pvpDeck.ts; kept separate so the client tree doesn't depend on @nw/shared.

export const PVP_DECK_SIZE = 10;

export const PVP_BASE_CARDS: readonly string[] = [
  'infantry_1', 'shieldbearer_1', 'archer_1', 'max_1', 'lena_1', 'mara_1',
  'barracks_1', 'tower_1',
  'haste_1', 'meteor_1',
];

export const PVP_BUILDING_CARDS: readonly string[] = ['barracks_1', 'tower_1'];
export const PVP_SPELL_CARDS: readonly string[] = ['haste_1', 'meteor_1'];

export const PVP_UNLOCK_TIERS: ReadonlyArray<{ minElo: number; cards: readonly string[] }> = [
  { minElo: 1500, cards: ['runner', 'ironclad'] },
  { minElo: 2100, cards: ['berserker', 'splitter'] },
  { minElo: 2400, cards: ['harpy', 'medic'] },
];

export function getPvpUnlockedCards(seasonPeakElo: number): string[] {
  const cards: string[] = [...PVP_BASE_CARDS];
  for (const tier of PVP_UNLOCK_TIERS) {
    if (seasonPeakElo >= tier.minElo) cards.push(...tier.cards);
  }
  return cards;
}

export function defaultPvpDeck(): string[] {
  return [...PVP_BASE_CARDS];
}

export function validatePvpDeckClient(deck: string[], seasonPeakElo: number): string | null {
  if (deck.length !== PVP_DECK_SIZE) return `Select exactly ${PVP_DECK_SIZE} cards (${deck.length} selected)`;
  const unlocked = new Set(getPvpUnlockedCards(seasonPeakElo));
  const seen = new Set<string>();
  for (const card of deck) {
    if (!unlocked.has(card)) return `Card "${card}" is not unlocked`;
    if (seen.has(card)) return `Duplicate card "${card}"`;
    seen.add(card);
  }
  if (!deck.some((c) => PVP_BUILDING_CARDS.includes(c))) return 'Deck must include at least 1 building';
  if (!deck.some((c) => PVP_SPELL_CARDS.includes(c))) return 'Deck must include at least 1 spell';
  return null;
}
