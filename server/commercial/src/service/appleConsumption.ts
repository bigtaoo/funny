// Consumption data for Apple refund requests (CONSUMPTION_REQUEST, App Store Server API v2).
//
// When a customer asks Apple for a refund, Apple gives us 12 hours to say how much of the purchase was
// actually used. It decides with or without our answer, so silence forfeits the only input we get —
// which for a game selling coin packs is the whole defence against "buy coins, spend them, refund".
//
// ── ⚠️ Consent gate: why this currently never sends ──
// Apple requires `customerConsented: true`, and requires that the consent be collected **by the app**,
// from the customer, before any consumption data is sent; a submission with `false` is rejected
// outright, and Apple's guidance for "no consent" is to not respond at all. The shipped iOS binary has
// no such consent UI — that is client work, and this migration's phase A is server-only
// (IOS_RELEASE.md §6). So everything here is built and tested, and `customerHasConsented` returns
// false until the client can actually ask. Recording the notification still happens; only the reply is
// withheld. Claiming consent we never obtained would be a false statement to Apple about a customer.
import type { WalletCore } from './base';
import type { AppleTransaction } from '../iap/appleServerApi';
import type { ConsumptionRequest } from '@apple/app-store-server-library';

/** Apple's consumptionPercentage is in milliunits: 100000 = the whole purchase was consumed. */
const MILLIUNITS_FULL = 100000;

/**
 * Whether this customer agreed to share consumption data with Apple.
 *
 * Hard-false until the app can ask (see the file header). Kept as a function rather than a constant so
 * the phase-B change is one implementation swap — read the stored per-account consent — rather than a
 * hunt through call sites.
 */
export function customerHasConsented(_accountId: string): boolean {
  return false;
}

/**
 * How much of a coin purchase the player actually spent, in Apple's milliunits.
 *
 * Measured from the ledger: every debit after the purchase landed, capped at what the purchase itself
 * granted. That deliberately over-reports rather than under-reports consumption when a player had a
 * prior balance — spending is not attributable to a specific purchase, and the honest simplification
 * for a refund question ("did they use what they bought?") is to count spend since the purchase.
 *
 * Returns undefined when there is nothing to measure against (no matching recharge row), which is a
 * valid omission — `consumptionPercentage` is an optional field.
 */
export async function consumptionPercentage(
  core: WalletCore,
  accountId: string,
  tx: AppleTransaction,
): Promise<number | undefined> {
  const recharge = await core.cols.recharges.findOne({ _id: `apple:${tx.transactionId}` });
  if (!recharge || recharge.coinsGranted <= 0) return undefined;

  const spentRows = await core.cols.ledger
    .find({ accountId, ts: { $gte: recharge.ts }, delta: { $lt: 0 } })
    .toArray();
  const spent = spentRows.reduce((sum, row) => sum + Math.abs(row.delta), 0);

  const ratio = Math.min(1, spent / recharge.coinsGranted);
  return Math.round(ratio * MILLIUNITS_FULL);
}

/**
 * Build the answer to one CONSUMPTION_REQUEST.
 *
 * `deliveryStatus` is DELIVERED whenever our own records show the grant landed — the coins exist in
 * the ledger, so from the app's side the purchase worked. `refundPreference` is deliberately left
 * unset: expressing a preference is a customer-relations decision (and a fully-consumed purchase is
 * not automatically a refund to decline), whereas the consumption facts are simply facts. Apple
 * weighs the facts either way.
 */
export async function buildConsumptionRequest(
  core: WalletCore,
  accountId: string,
  tx: AppleTransaction,
  _reason: string | undefined,
): Promise<ConsumptionRequest> {
  const pct = await consumptionPercentage(core, accountId, tx);
  const delivered = pct !== undefined;
  return {
    customerConsented: customerHasConsented(accountId),
    consumptionPercentage: pct,
    deliveryStatus: delivered ? 'DELIVERED' : 'UNDELIVERED_OTHER',
    // No free trial or sample of a coin pack exists to have offered — coins are the product itself.
    sampleContentProvided: false,
  };
}
