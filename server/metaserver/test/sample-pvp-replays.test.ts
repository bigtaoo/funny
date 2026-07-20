// Unit coverage for samplePvpReplays.ts's sampling decision logic (BALANCE data pipeline P2 — see
// design/game/BALANCE.md §11.2). Importing the module must NOT connect to Mongo or run main() — the module
// guards its entrypoint with an `isMain` check so `isUpset` can be exercised directly (see samplePvpReplays.ts
// bottom). If this file ever starts hanging/timing out, that guard is the first thing to check.
import { describe, expect, it } from 'vitest';
import { isUpset, type MatchRow } from '../scripts/samplePvpReplays.js';

function row(overrides: Partial<MatchRow> & { winner: number; players: MatchRow['players'] }): MatchRow {
  return {
    _id: 'x', roomId: 'R', mode: 'ranked', ts: 0,
    ...overrides,
  };
}

describe('isUpset', () => {
  it('is false when there is no winner (draw/unknown)', () => {
    expect(isUpset(row({ winner: -1, players: [] }))).toBe(false);
  });

  it('is false when ELO data is missing for either side (friendly match, no settlement)', () => {
    expect(isUpset(row({
      winner: 0,
      players: [{ side: 0 }, { side: 1, eloDelta: 16, eloAfter: 1016 }],
    }))).toBe(false);
  });

  it('is false when the winner had the higher pre-match ELO (expected result)', () => {
    // winner (side 0) pre-match 1200, loser (side 1) pre-match 1000 — winner was already ahead.
    expect(isUpset(row({
      winner: 0,
      players: [
        { side: 0, eloDelta: 8, eloAfter: 1208 },
        { side: 1, eloDelta: -8, eloAfter: 992 },
      ],
    }))).toBe(false);
  });

  it('is false when the gap is below the UPSET_ELO_GAP threshold (149 short)', () => {
    // loser pre-match 1149, winner pre-match 1000 — 149-point gap, just under the 150 threshold.
    expect(isUpset(row({
      winner: 0,
      players: [
        { side: 0, eloDelta: 20, eloAfter: 1020 },
        { side: 1, eloDelta: -20, eloAfter: 1129 },
      ],
    }))).toBe(false);
  });

  it('is true at exactly the UPSET_ELO_GAP threshold (150)', () => {
    // loser pre-match 1150, winner pre-match 1000 — exactly 150-point gap.
    expect(isUpset(row({
      winner: 0,
      players: [
        { side: 0, eloDelta: 20, eloAfter: 1020 },
        { side: 1, eloDelta: -20, eloAfter: 1130 },
      ],
    }))).toBe(true);
  });

  it('is true for a clear upset (large underdog win)', () => {
    // winner (side 1) pre-match 900, loser (side 0) pre-match 1400 — 500-point gap.
    expect(isUpset(row({
      winner: 1,
      players: [
        { side: 0, eloDelta: -25, eloAfter: 1375 },
        { side: 1, eloDelta: 25, eloAfter: 925 },
      ],
    }))).toBe(true);
  });

  it('is false when the underdog side is not actually the winner passed in', () => {
    // side 0 is the lower-ELO side but side 1 (the higher-ELO side) is recorded as winner.
    expect(isUpset(row({
      winner: 1,
      players: [
        { side: 0, eloDelta: -20, eloAfter: 980 },
        { side: 1, eloDelta: 20, eloAfter: 1520 },
      ],
    }))).toBe(false);
  });
});
