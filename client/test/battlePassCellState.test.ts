// Direct unit coverage for BattlePassScene/cell.ts's cellState() — a pure state-machine function
// extracted in the 2026-08-12 form① split (client-modules.md §split convention) with zero prior
// test coverage, direct or indirect (no existing BattlePassScene test asserts on cell state/colour;
// battlepass.test.ts covers the unrelated hasBattlePassClaimable badge helper). Cheap and valuable
// to pin directly given the branch precedence (locked-by-missing-reward beats everything else,
// claimed beats level-gating, pass_required only applies to the paid track) is easy to get subtly
// wrong in a future edit and would otherwise only be caught by eyeballing a screenshot.
import { describe, it, expect } from 'vitest';
import { cellState } from '../src/scenes/BattlePassScene/cell';

describe('cellState (BattlePassScene/cell.ts)', () => {
  it('no reward defined for this level -> locked, regardless of any other flag', () => {
    expect(cellState('free', 3, 10, new Set([3]), new Set(), true, false)).toBe('locked');
    expect(cellState('paid', 3, 10, new Set(), new Set([3]), true, false)).toBe('locked');
  });

  it('already claimed (own track) -> claimed', () => {
    expect(cellState('free', 3, 10, new Set([3]), new Set(), false, true)).toBe('claimed');
    expect(cellState('paid', 3, 10, new Set(), new Set([3]), true, true)).toBe('claimed');
  });

  it("claimed status is per-track — the OTHER track's claimed set is not consulted", () => {
    // Level 3 claimed on the free track only: the paid cell at the same level must not read as claimed.
    expect(cellState('paid', 3, 10, new Set([3]), new Set(), true, true)).not.toBe('claimed');
  });

  it('level beyond the reached level -> locked (not yet claimable)', () => {
    expect(cellState('free', 11, 10, new Set(), new Set(), true, true)).toBe('locked');
  });

  it('paid track without an active pass -> pass_required, even at/below the reached level', () => {
    expect(cellState('paid', 3, 10, new Set(), new Set(), false, true)).toBe('pass_required');
  });

  it('paid track WITH an active pass, at/below the reached level, unclaimed -> claimable', () => {
    expect(cellState('paid', 3, 10, new Set(), new Set(), true, true)).toBe('claimable');
  });

  it('free track never needs a pass -> claimable once reached and unclaimed', () => {
    expect(cellState('free', 3, 10, new Set(), new Set(), false, true)).toBe('claimable');
  });

  it('exactly at the reached level counts as reached (boundary), not locked', () => {
    expect(cellState('free', 10, 10, new Set(), new Set(), false, true)).toBe('claimable');
  });
});
