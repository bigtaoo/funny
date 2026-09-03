// Apple auto-renewable subscription sync (IOS_RELEASE.md §4.1b).
//
// The monthly card on iOS is an auto-renewable subscription: Apple bills the player every month
// without the app being involved, without any user action, and — this is the part that needs code —
// without ever telling our server. StoreKit 1 surfaces each renewal as an extra transaction inside
// the app receipt, so re-reading that receipt and handing it to the server is how a renewal turns
// into 30 more days on the card. Nothing else in the client would ever notice one happened.
//
// The server applies each period under `apple:<transactionId>` and is idempotent on it, so calling
// this repeatedly is free; `granted` comes back 0 on essentially every call, which is why the save
// is only adopted when it isn't.
//
// Everything here is best-effort by construction: the player did not ask for this, so no failure it
// can hit is worth a toast, a retry, or a millisecond of the boot path. It runs once per session
// from the lobby (app/nav/lobby.ts — the same place the expiry reminder re-arms, and for the same
// reason: that is where "logged in, save loaded, not a resize redraw" is already known).
import { getNativeReceiptReader, getNativeBilling } from './iap';
import type { ApiClient } from '../net/ApiClient';
import type { SaveData } from '../game/meta/SaveData';
import { log } from '../app/appConstants';

/** One attempt per session: renewals arrive monthly, so re-asking Apple on every lobby entry is pure noise. */
let attempted = false;

/** Test seam — resets the once-per-session guard. */
export function resetAppleSubscriptionSyncForTest(): void {
  attempted = false;
}

/**
 * Grant any subscription period Apple has charged for but the server has not applied yet.
 * No-ops (silently, and without touching the network) on every platform but the iOS shell, and on an
 * iOS shell whose native binary predates the bridge's `receipt()` reader.
 *
 * @param adopt called only when the server actually granted something, with the authoritative save.
 */
export async function syncAppleSubscription(
  api: ApiClient,
  adopt: (save: SaveData) => void,
): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    if (getNativeBilling()?.kind !== 'apple') return;
    const readReceipt = getNativeReceiptReader();
    if (!readReceipt) return;
    const receipt = await readReceipt();
    if (!receipt) return;                       // fresh install / never purchased — nothing to sync
    const { save, granted } = await api.iapAppleSync(receipt);
    if (granted > 0) {
      log.info('apple subscription renewal applied', { granted });
      adopt(save);
    }
  } catch (e) {
    // Offline, Apple unreachable, server down, receipt rejected — all the same non-event. The next
    // cold start tries again, and the periods stay in the receipt until one of those attempts lands.
    log.warn('apple subscription sync skipped', { err: e instanceof Error ? e.message : String(e) });
  }
}
