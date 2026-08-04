// Regression coverage for validatePvpDeckClient's error messages (client/src/game/meta/pvpLoadout.ts).
//
// 2026-08-03 fix: these messages used to be hardcoded English literals, bypassing t() entirely —
// every other user-facing string in DeckBuilderScene is localized, so a non-English player saw raw
// English validation errors here. Now routed through t() with real translation keys.
import { describe, it, expect, beforeEach } from 'vitest';
import { initI18n, setLocale, t } from '../src/i18n';
import {
  PVP_DECK_SIZE,
  PVP_BASE_CARDS,
  PVP_BUILDING_CARDS,
  getPvpUnlockedCards,
  validatePvpDeckClient,
} from '../src/game/meta/pvpLoadout';

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
};

describe('validatePvpDeckClient — localized messages', () => {
  beforeEach(() => {
    initI18n('zh', memStore(), ['zh', 'en', 'de']);
    setLocale('zh');
  });

  it('wrong deck size → localized message, not hardcoded English', () => {
    const err = validatePvpDeckClient(['infantry_1'], 0);
    expect(err).toBe(t('pvp.err.deckSize', { size: PVP_DECK_SIZE, count: 1 }));
    expect(err).not.toContain('Select exactly');
  });

  it('a locked (not-yet-unlocked) card → localized message', () => {
    const deck = [...PVP_BASE_CARDS.slice(0, 9), 'runner']; // 'runner' needs elo>=1500
    const err = validatePvpDeckClient(deck, 0);
    expect(err).toBe(t('pvp.err.cardLocked', { card: 'runner' }));
    expect(err).not.toContain('is not unlocked');
  });

  it('a duplicate card → localized message', () => {
    const deck = [...PVP_BASE_CARDS.slice(0, 9), PVP_BASE_CARDS[0]];
    const err = validatePvpDeckClient(deck, 0);
    expect(err).toBe(t('pvp.err.duplicateCard', { card: PVP_BASE_CARDS[0] }));
    expect(err).not.toContain('Duplicate card');
  });

  it('missing a building card → localized message', () => {
    // High elo unlocks every tier, giving enough non-building cards to fill a full deck.
    const nonBuilding = getPvpUnlockedCards(3000).filter((c) => !PVP_BUILDING_CARDS.includes(c));
    expect(nonBuilding.length).toBeGreaterThanOrEqual(PVP_DECK_SIZE);
    const err = validatePvpDeckClient(nonBuilding.slice(0, PVP_DECK_SIZE), 3000);
    expect(err).toBe(t('pvp.err.needBuilding'));
    expect(err).not.toContain('must include at least 1 building');
  });

  it('a fully valid deck returns null (no error)', () => {
    expect(validatePvpDeckClient([...PVP_BASE_CARDS], 0)).toBeNull();
  });
});
