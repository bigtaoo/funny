// `hasRechargeClaimable` — the Shop peer-tab red dot for cumulative recharge milestones
// (GACHA_DESIGN §13 / ADR-045).
//
// The whole module is one function, and it had zero coverage (2026-09-10 FNDA sweep) even though
// `app/nav/shop/badges.ts` calls it on every shop navigation: the peer-badge suite drives the nav
// with a save that has no monetization block at all, so the function's own body was never entered.
// Its sibling `hasBattlePassClaimable` has had a nine-case suite since the day it landed
// (battlepass.test.ts) — same shape, same consequence, one of the two was just never written.
//
// What breaks quietly: the dot is the ONLY place the client tells a paying player a milestone is
// waiting (the Recharge screen is two taps deep and nothing else nags). Miss a claimable tier and
// the reward sits there until the player happens to look; show one that is already claimed and
// they walk to a screen with nothing to press. Neither errors, neither is visible in a log, and
// the server never notices — it hands out the reward whenever asked, dot or no dot.
import { describe, it, expect } from 'vitest';
import { hasRechargeClaimable } from '../src/game/meta/rechargeMilestone';
import { RECHARGE_TIERS } from '../src/game/balance/rechargeTierDefs';
import { makeNewSave, type SaveData } from '../src/game/meta/SaveData';

function save(patch: {
  cents?: number;
  claimed?: number[];
  noMonetization?: boolean;
  noMilestone?: boolean;
}): SaveData {
  const s = makeNewSave('acc-1', 1);
  if (!patch.noMonetization) {
    s.monetization = {
      fatePoints: 0,
      subscriptionExpiry: 0,
      starterUsed: [],
      ...(s.monetization ?? {}),
      totalRechargeCents: patch.cents ?? 0,
    };
  } else {
    delete s.monetization;
  }
  if (!patch.noMilestone) {
    s.rechargeMilestone = { claimed: patch.claimed ?? [] };
  } else {
    delete s.rechargeMilestone;
  }
  return s;
}

const T1 = RECHARGE_TIERS[0]!;
const T2 = RECHARGE_TIERS[1]!;

describe('hasRechargeClaimable', () => {
  it('is false for a fresh account that has never spent', () => {
    expect(hasRechargeClaimable(save({ cents: 0 }))).toBe(false);
  });

  it('is false one cent below the first threshold, true exactly at it', () => {
    // `>=`, not `>`: a player who buys precisely the 6.00 pack has reached tier 1. Off-by-one here
    // means the dot only appears after the NEXT purchase, which reads as "the reward is late".
    expect(hasRechargeClaimable(save({ cents: T1.thresholdCents - 1 }))).toBe(false);
    expect(hasRechargeClaimable(save({ cents: T1.thresholdCents }))).toBe(true);
  });

  it('goes quiet once the reached tier is claimed', () => {
    expect(hasRechargeClaimable(save({ cents: T1.thresholdCents, claimed: [T1.id] }))).toBe(false);
  });

  it('lights up again when spending reaches the next tier', () => {
    expect(hasRechargeClaimable(save({ cents: T2.thresholdCents, claimed: [T1.id] }))).toBe(true);
  });

  it('finds a SKIPPED lower tier, not just the highest one reached', () => {
    // Claiming tier 2 without ever claiming tier 1 is reachable (the screen claims per-row), so
    // "compare against the highest reached tier" would be wrong in a way that silently eats a
    // reward. The dot has to stay lit while ANY reached tier is unclaimed.
    expect(hasRechargeClaimable(save({ cents: T2.thresholdCents, claimed: [T2.id] }))).toBe(true);
  });

  it('is false when every reached tier is claimed, even with more tiers ahead', () => {
    expect(
      hasRechargeClaimable(save({ cents: T2.thresholdCents, claimed: [T1.id, T2.id] })),
    ).toBe(false);
    // Non-vacuity: there ARE unreached tiers above, i.e. the false above is about "claimed",
    // not about having run out of table.
    expect(RECHARGE_TIERS.length).toBeGreaterThan(2);
  });

  it('is false when everything is claimed at the top of the table', () => {
    const top = RECHARGE_TIERS[RECHARGE_TIERS.length - 1]!;
    const all = RECHARGE_TIERS.map((t) => t.id);
    expect(hasRechargeClaimable(save({ cents: top.thresholdCents, claimed: all }))).toBe(false);
    // …and the same spend with nothing claimed is the loudest possible true — the guard that
    // catches an implementation that always returns false.
    expect(hasRechargeClaimable(save({ cents: top.thresholdCents, claimed: [] }))).toBe(true);
  });

  it('treats a missing monetization block as zero spend rather than throwing', () => {
    // Both optional blocks are absent on every save made before ADR-045 shipped, and on every
    // account that has never opened the shop.
    expect(() => hasRechargeClaimable(save({ noMonetization: true, noMilestone: true }))).not.toThrow();
    expect(hasRechargeClaimable(save({ noMonetization: true, noMilestone: true }))).toBe(false);
  });

  it('treats a missing milestone block as "nothing claimed yet"', () => {
    expect(hasRechargeClaimable(save({ cents: T1.thresholdCents, noMilestone: true }))).toBe(true);
  });
});
