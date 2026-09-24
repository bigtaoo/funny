/**
 * Hand-off between the purchase flow and the stage-level SubscriptionDisclosureDialog.
 *
 * The nav layer (app/nav/shop/iap.ts) must show the auto-renewable subscription terms before the
 * StoreKit sheet opens (App Review guideline 3.1.2), but it has no access to the stage. app.ts
 * registers the sink that mounts the dialog; the nav layer awaits {@link requestSubscriptionDisclosure}.
 */

export type SubscriptionProduct = 'monthly_card' | 'year_card';

export interface SubscriptionDisclosureInfo {
  product: SubscriptionProduct;
  /** Price label to show, already formatted (storefront-localized when the store provided one). */
  price: string;
}

/** Mounts the dialog and calls `answer` exactly once: true = subscribe, false = cancelled/closed. */
export type SubscriptionDisclosureSink = (info: SubscriptionDisclosureInfo, answer: (accepted: boolean) => void) => void;

let sink: SubscriptionDisclosureSink | null = null;

export function setSubscriptionDisclosureSink(next: SubscriptionDisclosureSink | null): void {
  sink = next;
}

/**
 * Show the disclosure and resolve with the player's answer. With no sink registered it resolves
 * false: a purchase that cannot show its terms must not proceed.
 */
export function requestSubscriptionDisclosure(info: SubscriptionDisclosureInfo): Promise<boolean> {
  const current = sink;
  if (!current) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const answer = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };
    try { current(info, answer); } catch { answer(false); }
  });
}
