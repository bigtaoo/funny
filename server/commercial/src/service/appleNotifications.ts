// App Store Server Notifications V2 (2026-09-07). Apple pushes subscription lifecycle and refund
// events here; metaserver's /iap/apple/notifications route forwards the signed payload verbatim and
// this is where it is verified and acted on.
//
// ── Why verification happens here, not at the edge ──
// metaserver terminates the HTTP request (like it does for Paddle and AdMob), but every Apple
// credential and the pinned root certificates live in commercial. Verifying here keeps them in one
// service instead of duplicating the configuration — and keeps "who may grant money" and "who decides
// a payload is genuine" as the same component.
//
// ── What actually grants ──
// Only SUBSCRIBED and DID_RENEW. Everything else is recorded and nothing more: expiries and billing
// failures need no action (the subscription simply runs out on its own), and refunds deliberately do
// not claw back days already granted — the same posture the Paddle channel takes (GACHA_DESIGN §13).
// CONSUMPTION_REQUEST is the one non-granting type that still does work: it answers Apple.
import {
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  YEAR_CARD_DAYS,
  YEAR_CARD_IMMEDIATE_COINS,
} from '@nw/shared';
import type { Result, WalletCore } from './base';
import type { AppleNotification, AppleTransaction } from '../iap/appleServerApi';
import { resolveNonCoinProduct } from '../iap/productResolve';
import { buildConsumptionRequest, customerHasConsented } from './appleConsumption';

/** What the webhook did with a notification. Recorded on the log row and returned for the caller's logs. */
export type AppleNotificationOutcome =
  | 'granted'
  | 'ignored'
  | 'unlinked'
  | 'unverified'
  | 'consumption_sent'
  | 'consumption_failed'
  | 'consumption_no_consent';

export interface AppleNotificationHandlers {
  /**
   * Verify and act on one App Store Server Notification.
   *
   * Never throws for a payload problem: a forged, malformed or unroutable notification is recorded
   * (where possible) and reported as an outcome, because the caller must answer Apple 200 either way
   * — a non-2xx only buys a redelivery of the same unusable payload.
   */
  appleNotification(args: { signedPayload: string }): Promise<Result<{ outcome: AppleNotificationOutcome }>>;
}

/** The two SKUs that renew; a notification about anything else grants nothing. */
function subscriptionProductOf(tx: AppleTransaction): 'monthly_card' | 'year_card' | null {
  const product = resolveNonCoinProduct(tx.productId);
  return product === 'monthly_card' || product === 'year_card' ? product : null;
}

export class AppleNotificationService {
  constructor(private readonly core: WalletCore) {}

  /**
   * Which account this notification concerns.
   *
   * Apple sends no identifier of ours, so the answer comes from what we recorded at purchase time
   * (db.ts's AppleTransactionLinkDoc). `appAccountToken` — the id Apple carries on behalf of the app
   * — is checked first and is currently always absent: the shipped StoreKit 1 binary cannot set it.
   * When the StoreKit 2 client lands (IOS_RELEASE.md §6 phase B) it becomes the primary key and this
   * lookup becomes the fallback that heals purchases the token missed.
   */
  private async resolveAccount(tx: AppleTransaction): Promise<string | null> {
    const link = await this.core.cols.appleTransactionLinks.findOne({ _id: tx.originalTransactionId });
    return link?.accountId ?? null;
  }

  /** Record every notification, routed or not — this log is the only trace support has of what Apple sent. */
  private async record(
    n: AppleNotification,
    outcome: AppleNotificationOutcome,
    accountId: string | null,
  ): Promise<void> {
    // Absent fields are omitted rather than written as undefined: the driver stores undefined as an
    // explicit null, and then the obvious support query for exactly the rows that matter —
    // `{ accountId: { $exists: false } }`, "which charges could we not route to a player" — matches
    // nothing at all, because the field does exist and merely holds null.
    const set: Record<string, unknown> = {
      notificationType: n.notificationType,
      outcome,
      ts: this.core.now(),
    };
    const optional: Record<string, string | undefined> = {
      subtype: n.subtype,
      accountId: accountId ?? undefined,
      transactionId: n.transaction?.transactionId,
      originalTransactionId: n.transaction?.originalTransactionId,
      productId: n.transaction?.productId,
      consumptionRequestReason: n.consumptionRequestReason,
    };
    for (const [k, v] of Object.entries(optional)) if (v !== undefined) set[k] = v;

    try {
      await this.core.cols.appleNotifications.updateOne(
        { _id: n.notificationUUID },
        { $set: set },
        { upsert: true },
      );
    } catch {
      // The log is diagnostic, not transactional — losing a row must not cost the grant above it.
    }
  }

  /**
   * Extend the subscription for one period Apple has already charged for.
   *
   * `renewal: true` is required and safe: Apple bills about a day before the current period ends, so
   * the card is still running when its own renewal arrives and the single-slot gate would otherwise
   * reject money that has already left the customer's account (see subscriptionCardBuy's flag doc).
   * Idempotency is unchanged — `apple:<transactionId>` is the same orderId the cold-start sync uses,
   * so a notification and a sync covering the same period grant exactly once between them.
   */
  private async grantPeriod(accountId: string, tx: AppleTransaction, product: 'monthly_card' | 'year_card') {
    return this.core.subscriptionCardBuy({
      accountId,
      orderId: `apple:${tx.transactionId}`,
      channel: 'apple',
      days: product === 'year_card' ? YEAR_CARD_DAYS : MONTHLY_CARD_DAYS,
      immediateCoins: product === 'year_card' ? YEAR_CARD_IMMEDIATE_COINS : MONTHLY_CARD_IMMEDIATE_COINS,
      renewal: true,
    });
  }

  /**
   * Answer a refund request within Apple's 12-hour window.
   *
   * Apple decides the refund with or without us; staying silent forfeits the only input we get. For a
   * coin pack the decisive fact is how much of the purchase was actually spent, which the ledger
   * knows (appleConsumption.ts assembles it).
   *
   * Without the customer's consent nothing is sent at all: Apple rejects a submission that reports
   * `customerConsented: false`, and its own guidance for that case is to not respond. The gate is
   * currently always closed because collecting that consent needs app UI that does not exist yet —
   * see appleConsumption.ts's header.
   */
  private async answerConsumptionRequest(
    n: AppleNotification,
    tx: AppleTransaction,
    accountId: string,
  ): Promise<AppleNotificationOutcome> {
    const api = this.core.appleServerApi;
    if (!api) return 'ignored';
    if (!customerHasConsented(accountId)) return 'consumption_no_consent';
    try {
      const request = await buildConsumptionRequest(this.core, accountId, tx, n.consumptionRequestReason);
      await api.sendConsumption(tx.transactionId, request);
      return 'consumption_sent';
    } catch {
      // Best effort: a failure here loses our say in one refund decision, nothing more.
      return 'consumption_failed';
    }
  }

  async appleNotification(args: {
    signedPayload: string;
  }): Promise<Result<{ outcome: AppleNotificationOutcome }>> {
    const api = this.core.appleServerApi;
    if (!api) return { ok: false, error: 'BAD_REQUEST' };

    const n = await api.verifyNotification(args.signedPayload).catch(() => null);
    // Nothing verifiable — no notificationUUID to key a log row on, so there is nothing to record either.
    if (!n) return { ok: true, outcome: 'unverified' };

    const tx = n.transaction;
    const product = tx ? subscriptionProductOf(tx) : null;
    const grants = n.notificationType === 'SUBSCRIBED' || n.notificationType === 'DID_RENEW';

    if (!tx) {
      await this.record(n, 'ignored', null);
      return { ok: true, outcome: 'ignored' };
    }

    const accountId = await this.resolveAccount(tx);
    if (!accountId) {
      // Apple charged someone we cannot identify. Recorded rather than dropped: this row is the only
      // way anyone finds out, and the cold-start sync still repairs the player's balance when they
      // next open the app (which is also when the missing link gets written).
      await this.record(n, 'unlinked', null);
      return { ok: true, outcome: 'unlinked' };
    }

    if (n.notificationType === 'CONSUMPTION_REQUEST') {
      const outcome = await this.answerConsumptionRequest(n, tx, accountId);
      await this.record(n, outcome, accountId);
      return { ok: true, outcome };
    }

    if (!grants || !product || tx.revoked) {
      await this.record(n, 'ignored', accountId);
      return { ok: true, outcome: 'ignored' };
    }

    const res = await this.grantPeriod(accountId, tx, product);
    const outcome: AppleNotificationOutcome = res.ok ? 'granted' : 'ignored';
    await this.record(n, outcome, accountId);
    return { ok: true, outcome };
  }
}
