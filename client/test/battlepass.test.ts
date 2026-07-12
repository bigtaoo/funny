// Unit tests for the battle-pass claimable-reward check (game/meta/battlepass.ts), which
// feeds the Shop/Gacha/BattlePass peer-tab red dot (LOBBY_IA_REDESIGN P1.5 §9). Regression
// coverage for the "BattlePass tab never shows a badge" gap found alongside the DailyScene
// sidebar-badge fix (2026-07-12).
import { describe, it, expect } from 'vitest';
import { hasBattlePassClaimable } from '../src/game/meta/battlepass';
import { BATTLEPASS_MAX_LEVEL, BP_XP_PER_LEVEL } from '../src/game/balance/battlepassDefs';
import type { SaveData } from '../src/game/meta/SaveData';

type BP = NonNullable<SaveData['battlePass']>;

function bp(overrides: Partial<BP>): BP {
  return {
    seasonNo: 1,
    xp: 0,
    level: 1,
    hasPass: false,
    claimedFree: [],
    claimedPaid: [],
    ...overrides,
  };
}

describe('hasBattlePassClaimable', () => {
  it('no battle pass yet (undefined) → not claimable', () => {
    expect(hasBattlePassClaimable(undefined)).toBe(false);
  });

  it('level 1, nothing claimed, no pass → free-track level 1 reward is claimable', () => {
    expect(hasBattlePassClaimable(bp({ xp: 0 }))).toBe(true);
  });

  it('level 1 free reward already claimed, no pass → nothing claimable', () => {
    expect(hasBattlePassClaimable(bp({ xp: 0, claimedFree: [1] }))).toBe(false);
  });

  it('has pass but paid reward for the reached level not yet claimed → claimable', () => {
    expect(hasBattlePassClaimable(bp({ xp: 0, hasPass: true, claimedFree: [1] }))).toBe(true);
  });

  it('has pass, both free and paid claimed at the only reached level → not claimable', () => {
    expect(hasBattlePassClaimable(bp({ xp: 0, hasPass: true, claimedFree: [1], claimedPaid: [1] }))).toBe(false);
  });

  it('no pass → paid-track rewards never count as claimable, even unclaimed', () => {
    // Level 2 reached (xp = 1 level's worth), free claimed, paid never claimed, no pass.
    expect(hasBattlePassClaimable(bp({ xp: BP_XP_PER_LEVEL, claimedFree: [1, 2], hasPass: false }))).toBe(false);
  });

  it('an earlier unclaimed level counts even after reaching a much higher level', () => {
    const highXp = (BATTLEPASS_MAX_LEVEL - 1) * BP_XP_PER_LEVEL;
    const claimedFree = Array.from({ length: BATTLEPASS_MAX_LEVEL }, (_, i) => i + 1).filter((l) => l !== 3);
    expect(hasBattlePassClaimable(bp({ xp: highXp, claimedFree }))).toBe(true);
  });

  it('fully claimed through the max level (no pass) → not claimable', () => {
    const maxXp = BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL;
    const claimedFree = Array.from({ length: BATTLEPASS_MAX_LEVEL }, (_, i) => i + 1);
    expect(hasBattlePassClaimable(bp({ xp: maxXp, claimedFree }))).toBe(false);
  });
});
