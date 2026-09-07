// Ask an iOS player whether we may tell Apple how much of a purchase they used, if they ever ask
// Apple for a refund (IOS_RELEASE.md §4.1b — CONSUMPTION_REQUEST).
//
// ── Why the app has to ask at all ──
// When a customer requests a refund, Apple asks the seller for consumption data and gives it 12
// hours to answer. For a game selling coin packs that answer is the whole defence against "buy
// coins, spend them, refund" — but Apple requires the submission to carry `customerConsented: true`,
// and requires that consent to be collected BY THE APP from the customer. A report saying `false` is
// rejected outright, and Apple's guidance for the no-consent case is to not answer at all. So
// without this question the server-side defence exists and never fires.
//
// ── When it is asked ──
// Once, after the player has actually paid for something (`totalRechargeCents > 0`) — the question is
// meaningless noise before that, and asking a paying player once is the least intrusive form of it.
// Both answers are recorded, locally and server-side: "declined" is an answer, and re-asking someone
// who said no would be nagging for something they already refused.
import { getNativeBilling } from './iap';
import type { ApiClient } from '../net/ApiClient';
import type { IStorage } from './IPlatform';
import type { SaveData } from '../game/meta/SaveData';
import { log } from '../app/appConstants';

/** Local marker that the question has been put to this player, whatever they answered. */
const ASKED_KEY = 'nw.apple.consumptionConsentAsked';

/** Test seam — the local marker is the only state this module keeps. */
export function resetConsumptionConsentForTest(storage: IStorage): void {
  storage.removeItem(ASKED_KEY);
}

/**
 * Whether to put the consumption-data question to this player now.
 *
 * False on everything but the iOS shell (no other store asks us for consumption data), before the
 * player has paid for anything, and once they have answered. The local marker is deliberately what
 * gates re-asking rather than a server round trip: the answer is already stored server-side, and a
 * player whose device forgot the marker being asked a second time is a much smaller cost than a
 * lobby entry that waits on the network to decide whether to draw a card.
 */
export function shouldAskConsumptionConsent(storage: IStorage, save: SaveData): boolean {
  if (getNativeBilling()?.kind !== 'apple') return false;
  if ((save.monetization?.totalRechargeCents ?? 0) <= 0) return false;
  return storage.getItem(ASKED_KEY) !== '1';
}

/**
 * Store the player's answer: locally (so they are not asked again) and on the server (which is where
 * the webhook reads it).
 *
 * The local marker is written first and unconditionally. If the POST fails, the player keeps the
 * answer they gave and the server keeps its default of "no consent recorded" — which withholds the
 * reply to Apple. Failing closed is right: the alternative is asking again until a request succeeds,
 * and the one thing worse than not answering Apple is claiming a consent nobody confirmed.
 */
export async function recordConsumptionConsent(
  api: ApiClient,
  storage: IStorage,
  consented: boolean,
): Promise<void> {
  storage.setItem(ASKED_KEY, '1');
  try {
    await api.setAppleConsumptionConsent(consented);
  } catch (e) {
    log.warn('apple consumption consent not stored', {
      consented,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
