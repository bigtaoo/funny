// Account-deletion purge (POST /internal/accounts/:accountId/purge), called by metaserver's purge job
// once a soft-deleted account's grace period is over.
//
// ── Why this service does not simply delete everything ──
// Payment records carry retention obligations of their own (tax/accounting, chargeback and refund
// disputes, the platform stores' own refund flows), which outlive the player's account. The design
// answer is to keep the minimum set and cut it loose from identity: `accountId` stays on the retained
// rows as an opaque id, but metaserver reduces the account row it points at to a tombstone with no
// personal data, so the id no longer leads to a person. What this file removes is everything that is
// NOT a payment record — balances, draw history, promo use, Apple routing tokens and consent — plus the
// bulky raw provider payloads on the rows that are kept.
//
// How long they are kept is not this file's concern: every payment record — purged account or not — is
// deleted after ten full calendar years by transactionRetention.ts.
//
// ── Retained (minimized) ──
//   ledger / orders            the accounting trail; ids, amounts, timestamps only — nothing to strip.
//   recharges                  kept for receipt dedupe (a replayed receiptId must still be refused) and for
//                              paddleRefund (needs accountId/usdCents/refundedAt). `rawReceipt` is blanked:
//                              it is only ever written, never read — every replay/refund/heal path keys on
//                              `_id`/`accountId`/`product`/`usdCents` (service/recharge.ts).
//   paddleEvents               the support log of what Paddle told us. `rawEvent` is blanked: its one reader
//                              is the ops "Paddle events" detail view (listPaddleEvents), a diagnosis aid
//                              whose value for a deleted account does not outweigh the personal data a
//                              Paddle payload may carry (customer/address/business blocks, custom data).
//   appleTransactionLinks      kept so a later Apple notification about this subscription is recognised
//                              and recorded against the same opaque id, but stamped `accountPurgedAt`, which
//                              appleNotifications.ts reads as "unroutable" — without that stamp a DID_RENEW
//                              for the deleted account would re-create its wallet through subscriptionCardBuy.
//   appleNotifications         Apple's own log rows; they already hold only ids and outcomes.
//
// Raw payloads are overwritten with '' rather than `$unset`: both fields are declared (and read by admin,
// metaserver's commercial client and the ops tool) as a required string, and an empty string keeps that
// shape true for every consumer while carrying nothing. `accountPurgedAt` on the stripped rows tells
// support why the payload is empty.
//
// Every operation is a deleteMany/updateMany by account, so a re-run after a partial failure just finishes
// the job; a Paddle event redelivered after the purge (which re-writes `rawEvent`) is stripped again by the
// next run, because the filter matches any row whose payload is not already blank.
import type { WalletCore } from './base';

export interface AccountPurgeResult {
  done: true;
  removed: {
    wallets: number;
    gachaHistory: number;
    promoRedemptions: number;
    appleAccountTokens: number;
    appleConsumptionConsents: number;
  };
  /** Retained payment rows minimized in this run (payload blanked and/or stamped `accountPurgedAt`). */
  minimized: {
    recharges: number;
    paddleEvents: number;
    appleTransactionLinks: number;
  };
}

export class AccountPurgeService {
  constructor(private readonly core: WalletCore) {}

  async purgeAccount(accountId: string): Promise<AccountPurgeResult> {
    const { cols } = this.core;
    const now = this.core.now();
    // Pipeline $set so the FIRST purge time survives re-runs ($ifNull keeps an existing stamp).
    const stamp = { accountPurgedAt: { $ifNull: ['$accountPurgedAt', now] } };

    const [wallets, gachaHistory, promoRedemptions, appleAccountTokens, appleConsumptionConsents] = await Promise.all([
      cols.wallets.deleteMany({ _id: accountId }),
      cols.gachaHistory.deleteMany({ accountId }),
      cols.promoRedemptions.deleteMany({ accountId }),
      cols.appleAccountTokens.deleteMany({ accountId }),
      cols.appleConsumptionConsents.deleteMany({ _id: accountId }),
    ]);

    const [recharges, paddleEvents, appleTransactionLinks] = await Promise.all([
      cols.recharges.updateMany(
        { accountId, $or: [{ rawReceipt: { $ne: '' } }, { accountPurgedAt: { $exists: false } }] },
        [{ $set: { rawReceipt: '', ...stamp } }],
      ),
      cols.paddleEvents.updateMany(
        { accountId, $or: [{ rawEvent: { $ne: '' } }, { accountPurgedAt: { $exists: false } }] },
        [{ $set: { rawEvent: '', ...stamp } }],
      ),
      cols.appleTransactionLinks.updateMany(
        { accountId, accountPurgedAt: { $exists: false } },
        { $set: { accountPurgedAt: now } },
      ),
    ]);

    return {
      done: true,
      removed: {
        wallets: wallets.deletedCount,
        gachaHistory: gachaHistory.deletedCount,
        promoRedemptions: promoRedemptions.deletedCount,
        appleAccountTokens: appleAccountTokens.deletedCount,
        appleConsumptionConsents: appleConsumptionConsents.deletedCount,
      },
      minimized: {
        recharges: recharges.modifiedCount,
        paddleEvents: paddleEvents.modifiedCount,
        appleTransactionLinks: appleTransactionLinks.modifiedCount,
      },
    };
  }
}
