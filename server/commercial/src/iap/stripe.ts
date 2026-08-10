// Split from iap.ts (2026-08-10, independent function module range 6, part 6/7).
// Stripe (Web).
import { resolveCoinsFromAmount, resolveNonCoinProductFromAmount } from './productResolve';
import type { IapTierMap, IapVerifyResult } from './types';

/**
 * Stripe payment intent verification.
 * Environment variable: NW_STRIPE_SECRET_KEY (sk_live_… or sk_test_…)
 *
 * receipt = payment_intent_id (e.g. pi_xxx)
 * amount unit is cents (USD); match to a tier to award coins.
 */
export async function stripeVerify(
  paymentIntentId: string,
  tierMap: IapTierMap,
  secretKey: string,
): Promise<IapVerifyResult> {
  let resp: Response;
  try {
    resp = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-04-10',
      },
    });
  } catch (e) {
    throw new Error(`stripe fetch failed: ${(e as Error).message}`);
  }
  if (resp.status === 404) return { ok: false, coins: 0 };
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`stripe query error ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as {
    status?: string;
    amount?: number;
    currency?: string;
  };

  if (data.status !== 'succeeded') return { ok: false, coins: 0 };
  const amountCents = data.amount ?? 0;
  const product = resolveNonCoinProductFromAmount(amountCents);
  if (product) return { ok: true, coins: 0, product };
  const coins = resolveCoinsFromAmount(amountCents, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}
