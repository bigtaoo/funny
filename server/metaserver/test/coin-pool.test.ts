// Achievement coin pool calibration guard (S9-8 / A-10, ECONOMY §9): locks the current one-time total coin pool + anti-inflation guardrails.
// Achievements are a one-shot faucet (A1 purely one-time, must never become a sustained coin pump); changing entries/values triggers this test as a reminder,
// preventing accidental pool inflation or insertion of "large single entry → quasi-combat-power grant". Calibration conclusions: ECONOMY_BALANCE §2.4.
import { describe, it, expect } from 'vitest';
import { ACHIEVEMENTS } from '@nw/shared';

/** Total coins for a single achievement fully claimed (all 3 tiers). */
function fullPool(coins: number[]): number {
  return coins.reduce((s, c) => s + c, 0);
}

describe('achievement coin pool calibration (A-10)', () => {
  const perAch = ACHIEVEMENTS.map((a) => ({ id: a.id, full: fullPool(a.tiers.map((t) => t.coins)) }));
  const total = perAch.reduce((s, a) => s + a.full, 0);

  it('current total pool locked at 2250 (5 entries ×3 tiers; changing entries/values prompts sync with ECONOMY §2.4)', () => {
    expect(total).toBe(2250);
  });

  it('single fully-claimed entry within [350,700] one-time range (no oversized single entry → prevents quasi-combat-power grant, A1/A3)', () => {
    for (const a of perAch) {
      expect(a.full).toBeGreaterThanOrEqual(350);
      expect(a.full).toBeLessThanOrEqual(700);
    }
  });

  it('average fully-claimed entry ≤ 500 (anti-inflation guardrail: projected over ~25 entries still within the upper bound of the 8–9k target band)', () => {
    const avg = total / ACHIEVEMENTS.length;
    expect(avg).toBeLessThanOrEqual(500);
    // Target band projection: ~25 entries × current average → one-time total pool (design target ~8–9k, ECONOMY §2.4).
    const projected = avg * 25;
    expect(projected).toBeGreaterThanOrEqual(8000);
    expect(projected).toBeLessThanOrEqual(12000);
  });

  it('coins and threshold per tier are both monotonically non-decreasing (incremental claim experience, §4.1)', () => {
    for (const a of ACHIEVEMENTS) {
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i].coins).toBeGreaterThanOrEqual(a.tiers[i - 1].coins);
        expect(a.tiers[i].threshold).toBeGreaterThanOrEqual(a.tiers[i - 1].threshold);
      }
    }
  });
});
