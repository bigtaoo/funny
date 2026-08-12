// Shop-group badge-claimable helpers: small, pure, take explicit params (SaveData slices) instead
// of closing over ctx — nothing else in the shop nav factories needs to call into these outside the
// three go*() nav functions, so plain functions are simpler than a ctx-taking factory here.
// Split out of createShopNav (see shop.ts).
import { hasBattlePassClaimable } from '../../../game/meta/battlepass';
import { hasRechargeClaimable } from '../../../game/meta/rechargeMilestone';
import { serverNow } from '../../../net/serverClock';
import type { SaveData } from '../../../game/meta/SaveData';

/**
 * Mirrors ShopScene's own Shop-tab badge (LOBBY_IA_REDESIGN P1.5): true when the monthly/year
 * card is active and today's daily reward is still unclaimed. Shared by every peer tab
 * (Gacha/BattlePass) so a user who lands there via the lobby's shop icon still sees the
 * monthly-card claim indicator on the Shop tab, wherever they are in the group.
 */
export function shopCardBadgeClaimable(m: SaveData['monetization'] | undefined): boolean {
  if (!m) return false;
  if ((m.subscriptionExpiry ?? 0) <= serverNow()) return false;
  const todayKey = new Date().toISOString().slice(0, 10);
  return m.subscriptionLastClaimDay !== todayKey;
}

/** Mirrors the Shop-tab badge helper above, for the BattlePass peer tab's claimable-level-reward dot. */
export function battlePassBadgeClaimable(bp: SaveData['battlePass'] | undefined): boolean {
  return hasBattlePassClaimable(bp);
}

/** Mirrors the Shop-tab badge helper above, for the Recharge peer tab's claimable-milestone-reward dot. */
export function rechargeBadgeClaimable(save: SaveData): boolean {
  return hasRechargeClaimable(save);
}
