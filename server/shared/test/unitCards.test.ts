// Unit tests for unitCards.ts: card-key parsing, unit-level derivation, card grants, gacha/level-drop sources
// (ECONOMY_NUMBERS §3/§4, ADR-009). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  UNIT_CARD_MAX_LEVEL,
  PROGRESSABLE_UNIT_IDS,
  isProgressableUnit,
  cardKey,
  parseCardKey,
  deriveUnitLevels,
  grantCards,
  levelCardReward,
} from '../src/unitCards';

// ── unit id set ───────────────────────────────────────────────────────────────────

describe('PROGRESSABLE_UNIT_IDS', () => {
  it('has 6 unique unit ids', () => {
    expect(PROGRESSABLE_UNIT_IDS).toHaveLength(6);
    expect(new Set(PROGRESSABLE_UNIT_IDS).size).toBe(6);
  });

  it('isProgressableUnit accepts members and rejects others', () => {
    expect(isProgressableUnit('infantry')).toBe(true);
    expect(isProgressableUnit('dragon')).toBe(false);
  });
});

// ── cardKey / parseCardKey ────────────────────────────────────────────────────────

describe('cardKey / parseCardKey', () => {
  it('round-trips a valid key', () => {
    const k = cardKey('archer', 3);
    expect(k).toBe('archer:3');
    expect(parseCardKey(k)).toEqual({ unitId: 'archer', level: 3 });
  });

  it('rejects unknown unit types', () => {
    expect(parseCardKey('dragon:2')).toBeNull();
  });

  it('rejects out-of-range levels', () => {
    expect(parseCardKey('archer:0')).toBeNull();
    expect(parseCardKey(`archer:${UNIT_CARD_MAX_LEVEL + 1}`)).toBeNull();
  });

  it('rejects malformed keys', () => {
    expect(parseCardKey('archer')).toBeNull();
    expect(parseCardKey(':3')).toBeNull();
    expect(parseCardKey('archer:x')).toBeNull();
    expect(parseCardKey('archer:2.5')).toBeNull();
  });
});

// ── deriveUnitLevels ──────────────────────────────────────────────────────────────

describe('deriveUnitLevels', () => {
  it('empty inventory yields no entries (all base level 1)', () => {
    expect(deriveUnitLevels({})).toEqual({});
  });

  it('takes the highest owned tier per unit', () => {
    const inv = { 'archer:2': 5, 'archer:4': 1, 'infantry:3': 2 };
    expect(deriveUnitLevels(inv)).toEqual({ archer: 4, infantry: 3 });
  });

  it('omits level-1 units (engine default)', () => {
    expect(deriveUnitLevels({ 'archer:1': 9 })).toEqual({});
  });

  it('ignores zero/negative counts and invalid keys', () => {
    const inv = { 'archer:3': 0, 'infantry:2': -1, 'dragon:5': 9, 'max:2': 1 };
    expect(deriveUnitLevels(inv)).toEqual({ max: 2 });
  });
});

// ── grantCards ────────────────────────────────────────────────────────────────────

describe('grantCards', () => {
  it('adds new cards and stacks existing ones', () => {
    const inv = { 'archer:2': 1 };
    expect(grantCards(inv, { 'archer:2': 2, 'infantry:3': 1 })).toEqual({ 'archer:2': 3, 'infantry:3': 1 });
  });

  it('skips invalid keys and non-positive amounts', () => {
    const inv = {};
    expect(grantCards(inv, { 'dragon:2': 5, 'archer:2': 0, 'infantry:3': -1 })).toEqual({});
  });

  it('does not mutate the input inventory', () => {
    const inv = { 'archer:2': 1 };
    grantCards(inv, { 'archer:2': 1 });
    expect(inv).toEqual({ 'archer:2': 1 });
  });
});

// ── levelCardReward ───────────────────────────────────────────────────────────────

describe('levelCardReward', () => {
  it('returns nothing for non-chapter levels', () => {
    expect(levelCardReward('ch_stress')).toEqual({});
    expect(levelCardReward('garbage')).toEqual({});
  });

  it('early chapters drop tier 1 cards', () => {
    const reward = levelCardReward('ch1_lv1');
    const [key, count] = Object.entries(reward)[0]!;
    expect(parseCardKey(key)!.level).toBe(1);
    expect(count).toBe(1);
  });

  it('tier climbs with chapter (ch3-4 → T2, ch5-6 → T3, capped at 3)', () => {
    expect(parseCardKey(Object.keys(levelCardReward('ch3_lv1'))[0]!)!.level).toBe(2);
    expect(parseCardKey(Object.keys(levelCardReward('ch5_lv1'))[0]!)!.level).toBe(3);
    // beyond ch6 stays capped at tier 3
    expect(parseCardKey(Object.keys(levelCardReward('ch9_lv1'))[0]!)!.level).toBe(3);
  });

  it('the chapter finale (lv10) drops double', () => {
    const reward = levelCardReward('ch1_lv10');
    expect(Object.values(reward)[0]).toBe(2);
  });

  it('unit type rotates by chapter', () => {
    const u1 = parseCardKey(Object.keys(levelCardReward('ch1_lv1'))[0]!)!.unitId;
    const u2 = parseCardKey(Object.keys(levelCardReward('ch2_lv1'))[0]!)!.unitId;
    expect(u1).toBe(PROGRESSABLE_UNIT_IDS[0]);
    expect(u2).toBe(PROGRESSABLE_UNIT_IDS[1]);
  });
});
