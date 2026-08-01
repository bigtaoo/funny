// Unit tests for the shared SLG team-troop helpers (client/src/game/meta/teamTroops.ts).
//
// Since the 2026-07-17 hero-card migration, an attack team's committed strength lives entirely in
// each card's cardState.currentTroops ledger. The server never persists an army entry that doesn't
// resolve to an owned cardInstanceId, so every entry these helpers see has one.
// These are pure functions — no PIXI harness needed, so this runs under the default vitest config.

import { describe, it, expect } from 'vitest';
import {
  carriedTroops, teamTroopCap, teamLeaderCard, TEAM_CAP, teamSlotId, teamSlotName, teamDisplayName,
} from '../src/game/meta/teamTroops';
import type { TeamTemplate, CardSLGState } from '../src/net/WorldApiClient';
import type { CardInstance } from '../src/game/meta/SaveData';

type Army = TeamTemplate['army'];

// Minimal army-entry builder (cast to the openapi type — only the fields the helpers read matter).
const card = (id: string, col = 0, row = 0): Army[number] => ({ cardInstanceId: id, col, row } as Army[number]);

/** Owned-card builder. 'lichuang' = troopCapBase 200 / growth 50; 'suyuan' = 100 / 25 (see cardDefs.ts). */
const inst = (id: string, defId: string, level: number): CardInstance => ({ id, defId, level, gear: {}, locked: false });

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
});

describe('teamTroopCap', () => {
  const cardInv = { c1: inst('c1', 'lichuang', 1), c2: inst('c2', 'suyuan', 3) };

  it('a missing army or cardInv has 0 capacity', () => {
    expect(teamTroopCap(undefined, cardInv)).toBe(0);
    expect(teamTroopCap([card('c1')], undefined)).toBe(0);
  });

  it('sums troopCap() across placed cards, scaling with level', () => {
    expect(teamTroopCap([card('c1')], cardInv)).toBe(200);          // 200 + 50*(1-1)
    expect(teamTroopCap([card('c2')], cardInv)).toBe(150);          // 100 + 25*(3-1)
    expect(teamTroopCap([card('c1'), card('c2')], cardInv)).toBe(350);
  });

  it('a card absent from cardInv contributes 0 (same as carriedTroops)', () => {
    expect(teamTroopCap([card('c1'), card('sold')], cardInv)).toBe(200);
  });
});

describe('teamLeaderCard', () => {
  // Same defId, different levels → cardPower is strictly ordered by level, so 'strong' wins the fallback.
  const cardInv = {
    weak: inst('weak', 'lichuang', 1),
    strong: inst('strong', 'lichuang', 5),
    other: inst('other', 'suyuan', 2),
  };
  const army = [card('weak'), card('strong')];

  it('an empty or unknown team has no leader', () => {
    expect(teamLeaderCard(undefined, cardInv)).toBeUndefined();
    expect(teamLeaderCard({ army: [], leaderCardId: undefined }, cardInv)).toBeUndefined();
    expect(teamLeaderCard({ army: [card('sold')], leaderCardId: undefined }, cardInv)).toBeUndefined();
  });

  it('honours an explicit leaderCardId even when it is not the strongest card', () => {
    expect(teamLeaderCard({ army, leaderCardId: 'weak' }, cardInv)?.id).toBe('weak');
  });

  it('falls back to the strongest card when no leader was ever chosen', () => {
    expect(teamLeaderCard({ army, leaderCardId: undefined }, cardInv)?.id).toBe('strong');
  });

  it('ignores a leader that is no longer in this team\'s army, or no longer owned', () => {
    expect(teamLeaderCard({ army, leaderCardId: 'other' }, cardInv)?.id).toBe('strong');
    expect(teamLeaderCard({ army, leaderCardId: 'sold' }, cardInv)?.id).toBe('strong');
  });

  it('breaks power ties on the lower cardInstanceId so the icon does not flicker', () => {
    const tied = { b: inst('b', 'lichuang', 2), a: inst('a', 'lichuang', 2) };
    expect(teamLeaderCard({ army: [card('b'), card('a')], leaderCardId: undefined }, tied)?.id).toBe('a');
    expect(teamLeaderCard({ army: [card('a'), card('b')], leaderCardId: undefined }, tied)?.id).toBe('a');
  });
});

// Moved here 2026-07-18 (from the now-deleted TeamsScene.ts) when the map-layer team list and
// train panel were removed as unreachable — CityScene still needs these for its team-card grid.
describe('TEAM_CAP / teamSlotId / teamSlotName', () => {
  it('TEAM_CAP is the UI-side formation slot count (server SIEGE_TEAM_CAP is authoritative)', () => {
    expect(TEAM_CAP).toBe(5);
  });

  it('teamSlotId is 1-indexed and stable across the cap', () => {
    expect(teamSlotId(0)).toBe('t1');
    expect(teamSlotId(4)).toBe('t5');
    expect(Array.from({ length: TEAM_CAP }, (_, i) => teamSlotId(i))).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('teamSlotName interpolates the 1-indexed slot number into the localized template', () => {
    expect(teamSlotName(0)).toBe('队伍 1');
    expect(teamSlotName(4)).toBe('队伍 5');
  });
});

// Added 2026-08-01 (§46) alongside the WorldMapNet.showTeamPicker fix: persistTeam() always saves
// name: '' (v1 has no custom-naming UI — see DefenseEditorScene/data.ts), so every reader of
// TeamTemplate.name must go through this fallback instead of the raw field.
describe('teamDisplayName', () => {
  it('prefers a non-empty name over the slot fallback', () => {
    expect(teamDisplayName({ id: 't1', name: 'Alpha' })).toBe('Alpha');
  });

  it('falls back to the live-localized slot name when name is empty, using the slot encoded in the id', () => {
    expect(teamDisplayName({ id: 't1', name: '' })).toBe('队伍 1');
    expect(teamDisplayName({ id: 't3', name: '' })).toBe('队伍 3');
    expect(teamDisplayName({ id: 't5', name: '' })).toBe('队伍 5');
  });

  it('falls back to the raw id if it is not in the expected t{n} slot-id shape', () => {
    expect(teamDisplayName({ id: 'legacy-team-id', name: '' })).toBe('legacy-team-id');
  });
});
