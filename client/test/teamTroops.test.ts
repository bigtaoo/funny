// Unit tests for the shared SLG team-troop helpers (client/src/game/meta/teamTroops.ts).
//
// Post the 2026-07-17 hero-card migration, an attack team's committed strength lives entirely in each
// card's cardState.currentTroops ledger. Legacy pre-migration teams store raw {unitType, initialHp}
// entries with no cardInstanceId and can never be dispatched, so the UI must treat them as carrying
// zero troops (they read 0 committed, drop out of the occupy picker, and get flagged for rebuild).
// These are pure functions — no PIXI harness needed, so this runs under the default vitest config.

import { describe, it, expect } from 'vitest';
import { isLegacyTeam, carriedTroops } from '../src/game/meta/teamTroops';
import type { TeamTemplate, CardSLGState } from '../src/net/WorldApiClient';

type Army = TeamTemplate['army'];

// Minimal army-entry builders (cast to the openapi type — only the fields the helpers read matter).
const card = (id: string, col = 0, row = 0): Army[number] => ({ cardInstanceId: id, col, row } as Army[number]);
const unit = (initialHp = 240): Army[number] => ({ unitType: 'shieldbearer', initialHp } as unknown as Army[number]);

describe('isLegacyTeam', () => {
  it('an empty or missing army is NOT legacy (just an unbuilt slot)', () => {
    expect(isLegacyTeam(undefined)).toBe(false);
    expect(isLegacyTeam([])).toBe(false);
  });

  it('an all-card army is NOT legacy', () => {
    expect(isLegacyTeam([card('c1'), card('c2')])).toBe(false);
  });

  it('an all-legacy (unit-type) army IS legacy', () => {
    expect(isLegacyTeam([unit(), unit()])).toBe(true);
  });

  it('a mixed army with even one non-card entry IS legacy', () => {
    expect(isLegacyTeam([card('c1'), unit()])).toBe(true);
  });
});

describe('carriedTroops', () => {
  const cardState: Record<string, CardSLGState> = {
    c1: { currentTroops: 100 } as CardSLGState,
    c2: { currentTroops: 150 } as CardSLGState,
  };

  it('a missing army or cardState carries 0', () => {
    expect(carriedTroops(undefined, cardState)).toBe(0);
    expect(carriedTroops([card('c1')], undefined)).toBe(0);
  });

  it('sums currentTroops across card entries', () => {
    expect(carriedTroops([card('c1'), card('c2')], cardState)).toBe(250);
  });

  it('a card absent from cardState contributes 0 (not NaN)', () => {
    expect(carriedTroops([card('c1'), card('unknown')], cardState)).toBe(100);
  });

  it('legacy (non-card) entries contribute 0 even when they carry a big initialHp', () => {
    expect(carriedTroops([unit(240), unit(290)], cardState)).toBe(0);
  });

  it('a mixed army counts only the card entries, ignoring the legacy ones', () => {
    expect(carriedTroops([card('c1'), unit(999)], cardState)).toBe(100);
  });
});
