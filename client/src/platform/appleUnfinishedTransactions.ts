// Report the App Store transactions that arrived outside a purchase (IOS_RELEASE.md §6, StoreKit 2).
//
// StoreKit hands the app three kinds of transaction nobody is standing in front of the shop for:
// an Ask-to-Buy purchase a parent approved hours later, a purchase restored from another device, and
// anything a previous install was charged for but never reported. With StoreKit 1 these came through
// the payment queue observer; with StoreKit 2 they arrive on `Transaction.updates`, which the native
// bridge queues (AppDelegate.swift) and this drains.
//
// ── Report first, finish second ──
// The native side deliberately finishes nothing. A transaction stays in StoreKit's queue — and is
// offered again on every launch — until the SERVER has granted it and this code calls finish(). That
// ordering is the difference between "we will retry until the player is paid" and "the money is gone
// and no record of it exists anywhere".
//
// Everything here is best-effort: the player did not ask for it, so no failure is worth a toast.
// Every endpoint used is idempotent on the transaction id, so a report that lands twice grants once.
import { getNativeBilling, getNativePendingReader, finishNativeTransaction } from './iap';
import type { ApiClient } from '../net/ApiClient';
import { ApiError } from '../net/ApiClient';
import type { SaveData } from '../game/meta/SaveData';
import { log } from '../app/appConstants';

/** One attempt per session: these are rare events, and the next cold start retries anything left. */
let attempted = false;

/** Test seam — resets the once-per-session guard. */
export function resetAppleTransactionDrainForTest(): void {
  attempted = false;
}

/** Ceiling on transactions reported in one pass, so a long backlog cannot turn boot into a POST storm. */
const MAX_PER_PASS = 20;

/**
 * Report one transaction to the endpoint that knows how to grant it.
 *
 * Routed on the product key rather than on a single "here is a transaction" endpoint because each of
 * the three product families already has a verifying endpoint with its own idempotency and its own
 * grant rules — a fourth path would be a second implementation of all three.
 *
 * @returns the authoritative save when the server granted something, or null when it granted nothing.
 */
async function report(
  api: ApiClient,
  transactionId: string,
  productKey: string,
): Promise<SaveData | null> {
  if (productKey === 'monthly_card' || productKey === 'year_card') {
    // The sync endpoint applies every period behind this transaction, not just this one, and is
    // idempotent per period — the same call the cold-start sync makes (appleSubscriptionSync.ts).
    const { save, granted } = await api.iapAppleSync(transactionId);
    return granted > 0 ? save : null;
  }
  if (productKey === 'starter_draw' || productKey === 'starter_growth') {
    const { save } = await api.starterBuy(productKey, 'apple', transactionId);
    return save;
  }
  const { save } = await api.iapVerify('apple', transactionId);
  return save;
}

/**
 * Whether a server rejection means "this will never work, stop offering it".
 *
 * ALREADY_PURCHASED is the only one: a starter pack the account already owns was delivered, so
 * finishing is correct and leaving it unfinished would re-report it on every launch forever. Every
 * other error — a rejected id, a wallet problem, Apple unreachable, the network down — is treated as
 * temporary, and the transaction stays in StoreKit's queue. Erring that way costs a retry; erring the
 * other way costs a player their purchase.
 */
function isSettled(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ALREADY_PURCHASED';
}

/**
 * Drain the native queue of unreported transactions, granting and then finishing each.
 *
 * No-ops (without touching the network) on every platform but the iOS shell, and on an iOS shell
 * whose native binary predates the StoreKit 2 bridge.
 *
 * @param adopt called with the authoritative save whenever the server actually granted something.
 */
export async function drainAppleTransactions(
  api: ApiClient,
  adopt: (save: SaveData) => void,
): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    if (getNativeBilling()?.kind !== 'apple') return;
    const readPending = getNativePendingReader();
    if (!readPending) return;
    const pending = await readPending();
    if (pending.length === 0) return;
    log.info('apple unfinished transactions found', { count: pending.length });

    for (const tx of pending.slice(0, MAX_PER_PASS)) {
      try {
        const save = await report(api, tx.transactionId, tx.productKey);
        await finishNativeTransaction(tx.transactionId);
        if (save) adopt(save);
      } catch (e) {
        if (isSettled(e)) {
          await finishNativeTransaction(tx.transactionId);
          continue;
        }
        // Left unfinished on purpose: StoreKit offers it again next launch, and the server-side
        // record of "a charge nobody has been paid for" is the transaction still being in the queue.
        log.warn('apple transaction report failed, left for the next launch', {
          transactionId: tx.transactionId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    log.warn('apple transaction drain skipped', { err: e instanceof Error ? e.message : String(e) });
  }
}
