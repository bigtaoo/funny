// Client-side pure logic for the recharge-milestone claimable-reward check (GACHA_DESIGN §13, ADR-045).
// Mirrors RechargeScene's own per-tier state derivation but reduced to the single boolean the Shop peer-tab
// red dot needs — see hasBattlePassClaimable for the equivalent battle-pass helper.
import type { SaveData } from './SaveData';
import { RECHARGE_TIERS } from '../balance/rechargeTierDefs';

/** Any recharge tier already reached but not yet claimed → Shop peer-tab red dot. */
export function hasRechargeClaimable(save: SaveData): boolean {
  const totalRechargeCents = save.monetization?.totalRechargeCents ?? 0;
  const claimed = new Set(save.rechargeMilestone?.claimed ?? []);
  return RECHARGE_TIERS.some((tier) => totalRechargeCents >= tier.thresholdCents && !claimed.has(tier.id));
}
