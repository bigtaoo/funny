// Consumption data for Apple refund requests (CONSUMPTION_REQUEST, App Store Server API v2).
//
// When a customer asks Apple for a refund, Apple gives us 12 hours to say how much of the purchase was
// actually used. It decides with or without our answer, so silence forfeits the only input we get —
// which for a game selling coin packs is the whole defence against "buy coins, spend them, refund".
//
// ── Consent gate ──
// Apple requires `customerConsented: true`, and requires that the consent be collected **by the app**,
// from the customer, before any consumption data is sent; a submission with `false` is rejected
// outright, and Apple's guidance for "no consent" is to not respond at all. So the app asks
// (SettingsScene → POST /iap/apple/consumption-consent) and the answer is stored per account
// (service/appleAccount.ts). An account that was never asked, or that declined, produces no reply to
// Apple whatsoever — the notification is still recorded, only the answer is withheld. Claiming consent
// we never obtained would be a false statement to Apple about one of its customers.
//
// Until 2026-09-07 this was hard-coded false (phase A was server-only, and the app had no way to ask),
// which meant the refund defence below was implemented but never actually fired.
import { hasAppleConsumptionConsent } from './appleAccount';
import type { WalletCore } from './base';
import type { AppleTransaction } from '../iap/appleServerApi';
import type { ConsumptionRequest } from '@apple/app-store-server-library';

/** Apple's consumptionPercentage is in milliunits: 100000 = the whole purchase was consumed. */
const MILLIUNITS_FULL = 100000;

/**
 * Whether this customer agreed to share consumption data with Apple.
 *
 * A thin re-export of the stored answer (service/appleAccount.ts) so callers reading this file see
 * where the flag in `buildConsumptionRequest` comes from. No consent recorded -> false, and the
 * webhook then declines to answer Apple at all rather than answering with a false.
 */
export function customerHasConsented(core: WalletCore, accountId: string): Promise<boolean> {
  return hasAppleConsumptionConsent(core, accountId);
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
    customerConsented: await customerHasConsented(core, accountId),
    consumptionPercentage: pct,
    deliveryStatus: delivered ? 'DELIVERED' : 'UNDELIVERED_OTHER',
    // No free trial or sample of a coin pack exists to have offered — coins are the product itself.
    sampleContentProvided: false,
  };
}
