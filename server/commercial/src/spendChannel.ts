// Payment-channel wallet isolation (ADR-020 / DECISIONS.md, design/product/deploy-cloudflare.md §7 point 2).
// Off-platform-purchased coins (Paddle/Stripe on web) must not be spendable inside Apple/Google's native apps
// (and vice versa) — each store's anti-circumvention IAP terms require that in-app content only be unlockable
// through that store's own purchases. WalletDoc.coins stays a single free pool (spendable everywhere: earned via
// ads/victory/promo/refund, or legacy pre-migration recharges); WalletDoc.recharged tags real-money top-ups by
// the channel they were bought through, spendable only when the request's client platform maps to that channel.
export type RechargeChannel = 'web' | 'apple' | 'google';

/**
 * Maps a recharge/IAP receipt-verification platform (RechargeDoc.platform: apple/google/wechat/stripe/paddle)
 * to the wallet's recharged-pool bucket it should fund. null = not a channel-restricted bucket (falls back to
 * the free `coins` pool) — currently only unrecognized platforms; 'wechat' never reaches this shared wallet in
 * practice (fully separate deployment/DB per ADR-019/020) but is included for completeness/tests.
 */
export function rechargeChannelOf(platform: string): RechargeChannel | null {
  switch (platform) {
    case 'paddle':
    case 'stripe':
      return 'web';
    case 'apple':
      return 'apple';
    case 'google':
      return 'google';
    default:
      return null;
  }
}

/**
 * Maps a client-declared request platform (X-NW-Platform header, threaded through meta as `clientPlatform`) to
 * the wallet bucket it may spend from / display, in addition to the always-spendable free `coins` pool.
 * Missing/unrecognized values (older clients that don't send the header yet, WeChat, CrazyGames) default to
 * 'web' — today's behavior for every currently-live client (no restriction), since no non-web client has ever
 * held an apple/google-recharged balance.
 */
export function spendChannelOf(clientPlatform: string | undefined): RechargeChannel {
  switch (clientPlatform) {
    case 'ios':
      return 'apple';
    case 'android':
      return 'google';
    default:
      return 'web';
  }
}

/**
 * Resolves which bucket a mutation's returned `coinsAfter` should reflect. Prefers the actual requester's
 * declared platform (`clientPlatform`, most accurate) when given; otherwise falls back to whichever bucket
 * `fundedChannel` just funded (so the return value doesn't omit money credited a moment ago), or 'web' when
 * neither is known (free-pool-only credits).
 */
export function displayChannelOf(fundedChannel: RechargeChannel | undefined, clientPlatform: string | undefined): RechargeChannel {
  if (clientPlatform !== undefined) return spendChannelOf(clientPlatform);
  return fundedChannel ?? 'web';
}

/** Effective balance visible/spendable for `channel`: the free pool plus that channel's recharged bucket. */
export function effectiveCoins(
  w: { coins: number; recharged?: Partial<Record<RechargeChannel, number>> } | null | undefined,
  channel: RechargeChannel,
): number {
  return (w?.coins ?? 0) + (w?.recharged?.[channel] ?? 0);
}
