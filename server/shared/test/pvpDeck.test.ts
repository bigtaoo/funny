// Unit tests for pvpDeck.ts: ELO-gated unlocks and deck validation rules (PVP_LOADOUT_DESIGN §3-4). Pure functions.
import { describe, it, expect } from 'vitest';
import {
  PVP_DECK_SIZE,
  PVP_BASE_CARDS,
  PVP_UNLOCK_TIERS,
  getPvpUnlockedCards,
  validatePvpDeck,
  defaultPvpDeck,
} from '../src/pvpDeck';

// ── base set / unlocks ────────────────────────────────────────────────────────────

describe('base card set', () => {
  it('has exactly the deck size (new players use the full base set)', () => {
    expect(PVP_BASE_CARDS).toHaveLength(PVP_DECK_SIZE);
  });

  it('has no duplicates', () => {
    expect(new Set(PVP_BASE_CARDS).size).toBe(PVP_BASE_CARDS.length);
  });

  it('contains at least one building and one spell (so the base deck is valid)', () => {
    const res = validatePvpDeck(defaultPvpDeck(), 0);
    expect(res.valid).toBe(true);
  });
});

describe('getPvpUnlockedCards', () => {
  it('a fresh player gets only the base set', () => {
    expect(getPvpUnlockedCards(1000).sort()).toEqual([...PVP_BASE_CARDS].sort());
  });

  it('diamond ELO unlocks the first tier', () => {
    const cards = getPvpUnlockedCards(1500);
    expect(cards).toContain('runner');
    expect(cards).toContain('ironclad');
    expect(cards).not.toContain('harpy');
  });

  it('king ELO unlocks everything', () => {
    const cards = getPvpUnlockedCards(2400);
    for (const tier of PVP_UNLOCK_TIERS) for (const c of tier.cards) expect(cards).toContain(c);
  });

  it('is cumulative and monotone in ELO', () => {
    expect(getPvpUnlockedCards(2400).length).toBeGreaterThan(getPvpUnlockedCards(1500).length);
    expect(getPvpUnlockedCards(1500).length).toBeGreaterThan(getPvpUnlockedCards(1000).length);
  });

  it('unlock thresholds are exclusive below minElo', () => {
    expect(getPvpUnlockedCards(1499)).not.toContain('runner');
    expect(getPvpUnlockedCards(1500)).toContain('runner');
  });
});

// ── validatePvpDeck ───────────────────────────────────────────────────────────────

describe('validatePvpDeck', () => {
  it('accepts the default base deck', () => {
    expect(validatePvpDeck(defaultPvpDeck(), 0).valid).toBe(true);
  });

  it('rejects a deck of the wrong size', () => {
    expect(validatePvpDeck(PVP_BASE_CARDS.slice(0, 9), 0).valid).toBe(false);
    expect(validatePvpDeck([...PVP_BASE_CARDS, 'infantry_1'], 0).valid).toBe(false);
  });

  it('rejects a locked card', () => {
    const deck = [...PVP_BASE_CARDS.slice(0, 9), 'harpy']; // harpy needs king ELO
    const res = validatePvpDeck(deck, 1000);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/not in unlocked set/);
  });

  it('accepts a previously-locked card once ELO qualifies', () => {
    const deck = [...PVP_BASE_CARDS.slice(0, 9), 'harpy'];
    expect(validatePvpDeck(deck, 2400).valid).toBe(true);
  });

  it('rejects duplicate cards', () => {
    const deck = [...PVP_BASE_CARDS.slice(0, 9), PVP_BASE_CARDS[0]!];
    const res = validatePvpDeck(deck, 0);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/duplicate/);
  });

  it('rejects a deck with no building', () => {
    // replace both buildings with unlocked non-building cards at king ELO
    const deck = ['infantry_1', 'shieldbearer_1', 'archer_1', 'max_1', 'lena_1', 'mara_1', 'haste_1', 'meteor_1', 'runner', 'ironclad'];
    const res = validatePvpDeck(deck, 2400);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/building/);
  });

  it('rejects a deck with no spell', () => {
    const deck = ['infantry_1', 'shieldbearer_1', 'archer_1', 'max_1', 'lena_1', 'mara_1', 'barracks_1', 'tower_1', 'runner', 'ironclad'];
    const res = validatePvpDeck(deck, 2400);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/spell/);
  });
});
