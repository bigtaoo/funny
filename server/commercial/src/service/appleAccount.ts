// Apple per-account state: the `appAccountToken` a purchase carries, and the player's consent to
// answer Apple's refund questions (IOS_RELEASE.md §4.1b / §6 phase B).
//
// ── Why the token is allocated here, before any purchase ──
// An App Store Server Notification carries Apple's ids and nothing of ours. `appleTransactionLinks`
// answers "whose subscription is this?" from what the original purchase reported — which works right
// up until a purchase is charged and never reported (the app is killed, the network dies, the player
// force-quits on the "thank you" screen). After that, every renewal notification for that
// subscription is unroutable and the player quietly stops being paid for.
//
// `appAccountToken` is Apple's answer to exactly that: a UUID of ours, attached to the purchase by
// StoreKit and echoed back on every transaction and notification about it. The only requirement is
// that we know what it means, which means it has to exist BEFORE the purchase. So it is allocated
// when the client asks (/bootstrap) and stored token -> account; nothing about the purchase itself is
// needed to write it down.
import { randomUUID } from 'node:crypto';
import type { Result, WalletCore } from './base';

/**
 * This account's `appAccountToken`, allocating one the first time it is asked for.
 *
 * Stable for the life of the account: every purchase a player makes carries the same token, so all of
 * their transactions resolve through one row. Concurrent first calls are safe — the unique index on
 * `accountId` (db.ts) rejects the loser, which then reads the winner's token rather than minting a
 * second identity for the same player.
 */
export async function appleAccountTokenFor(core: WalletCore, accountId: string): Promise<string> {
  const existing = await core.cols.appleAccountTokens.findOne({ accountId });
  if (existing) return existing._id;

  const token = randomUUID();
  try {
    await core.cols.appleAccountTokens.insertOne({ _id: token, accountId, createdAt: core.now() });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    const winner = await core.cols.appleAccountTokens.findOne({ accountId });
    if (winner) return winner._id;
    throw e; // a duplicate on something other than accountId: do not invent a token to paper over it
  }
  return token;
}

/**
 * Record which account owns an Apple subscription, keyed by the id Apple quotes in every future
 * renewal notification (db.ts's AppleTransactionLinkDoc explains why that pairing is only knowable
 * from a purchase). Upsert rather than insert: a Restore Purchases, a re-verify or a cold-start sync
 * re-asserts the same row instead of failing on a duplicate key, so a link that was missed can heal.
 *
 * Best-effort by design — the purchase itself must not fail because the bookkeeping row did not
 * write. A missing link costs future renewals, which appAccountToken and the cold-start sync both
 * still cover; a refused purchase costs the sale outright.
 */
export async function linkAppleSubscription(
  core: WalletCore,
  accountId: string,
  originalTransactionId: string,
  product: 'monthly_card' | 'year_card',
): Promise<void> {
  const now = core.now();
  try {
    await core.cols.appleTransactionLinks.updateOne(
      { _id: originalTransactionId },
      { $set: { accountId, product, updatedAt: now }, $setOnInsert: { linkedAt: now } },
      { upsert: true },
    );
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

/** Which account a transaction's `appAccountToken` belongs to, or null for a token we never issued. */
export async function accountForAppleAccountToken(
  core: WalletCore,
  token: string,
): Promise<string | null> {
  const row = await core.cols.appleAccountTokens.findOne({ _id: token });
  return row?.accountId ?? null;
}

/**
 * Record the player's answer to the consumption-data question the app asks (SettingsScene).
 *
 * Both answers are stored. "No" is not the same as "not asked": a stored false says the player was
 * asked and declined, which is worth being able to see, and it also stops the app from re-asking.
 */
export async function setAppleConsumptionConsent(
  core: WalletCore,
  accountId: string,
  consented: boolean,
): Promise<void> {
  await core.cols.appleConsumptionConsents.updateOne(
    { _id: accountId },
    { $set: { consented, ts: core.now() } },
    { upsert: true },
  );
}

/**
 * Whether this player consented to sharing consumption data with Apple.
 *
 * Absent row -> false, which is the correct default in both directions: Apple rejects a submission
 * that reports `customerConsented: false`, and its guidance for "no consent" is to not answer at all,
 * so an unasked player simply produces no reply (service/appleConsumption.ts).
 */
export async function hasAppleConsumptionConsent(
  core: WalletCore,
  accountId: string,
): Promise<boolean> {
  const row = await core.cols.appleConsumptionConsents.findOne({ _id: accountId });
  return row?.consented === true;
}

/**
 * The two handlers metaserver calls (internalHttp.ts routes them).
 *
 * Both answer in the `Result` envelope every other internal handler uses. That is not decoration:
 * internalHttp's `send` writes the returned object verbatim, so a handler returning a bare
 * `{ token }` reaches metaserver as a body with no `ok` field — which its client reads as a failure
 * and drops, silently, with the token never delivered and nothing logged anywhere.
 */
export class AppleAccountService {
  constructor(private readonly core: WalletCore) {}

  /** Get-or-create this account's appAccountToken, for the client to attach to its next purchase. */
  async appleAccountToken(args: { accountId: string }): Promise<Result<{ token: string }>> {
    return { ok: true, token: await appleAccountTokenFor(this.core, args.accountId) };
  }

  /** Store the player's consumption-data consent (the app collects it; Apple requires that it does). */
  async appleConsumptionConsent(args: {
    accountId: string;
    consented: boolean;
  }): Promise<Result<{ consented: boolean }>> {
    await setAppleConsumptionConsent(this.core, args.accountId, args.consented);
    return { ok: true, consented: args.consented };
  }
}
