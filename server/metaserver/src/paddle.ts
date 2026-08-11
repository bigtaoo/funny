// Paddle Billing integration (web IAP, ECONOMY_BALANCE.md §2.2).
//
// Two routes registered here:
//   POST /shop/paddle/checkout   — authenticated player creates a checkout session (returns transactionId)
//   POST /paddle/webhook         — Paddle server-side event (no player auth; HMAC-SHA256 verified)
//
// Environment variables:
//   NW_PADDLE_API_KEY           Paddle secret API key (sk_live_… or sk_test_…)
//   NW_PADDLE_WEBHOOK_SECRET    Paddle webhook signature secret (from Paddle dashboard)
//   NW_PADDLE_CLIENT_TOKEN      Paddle.js client-side token (sent to client via /bootstrap; ptok_…)
//   NW_PADDLE_PRICE_IDS         Tier → Paddle price ID map: "t499:pri_xxx,t999:pri_yyy,..."
//                               Also carries the subscription products (GACHA_DESIGN §5) under the
//                               reserved keys `monthly_card` / `year_card`, and the starter packs
//                               (GACHA_DESIGN §6) under `starter_draw` / `starter_growth`, e.g.
//                               "...,monthly_card:pri_zzz,year_card:pri_www,starter_draw:pri_aaa,starter_growth:pri_bbb"
//   NW_PADDLE_SANDBOX           "true" = use sandbox API (default false)
//
// 2026-08-11 (independent function modules form, claudedocs/server.md's "拆分形态的优先级" 形态①): this
// file is a zero-class set of near-independent operations (5 price-ID lookups, 1 signature verifier, 2
// route registrations) — same shape as equipment.ts/cards.ts's precedent. Split into:
//   paddle/priceIds.ts      NW_PADDLE_PRICE_IDS resolution (5 pure lookups, the DAG root)
//   paddle/signature.ts     webhook HMAC-SHA256 verification
//   paddle/types.ts         PaddleDeps
//   paddle/checkoutRoute.ts POST /shop/paddle/checkout (depends on priceIds.ts)
//   paddle/webhookRoute.ts  POST /paddle/webhook (depends on priceIds.ts + signature.ts)
// checkoutRoute.ts and webhookRoute.ts never call each other. This file collapses to the
// PaddleDeps re-export + registerPaddleRoutes, which just calls both registrations in the original
// order (checkout, then webhook) — same public API, `from './paddle.js'` import paths unchanged.
import type { FastifyInstance } from 'fastify';
import { registerCheckoutRoute } from './paddle/checkoutRoute.js';
import { registerWebhookRoute } from './paddle/webhookRoute.js';

export { coinsForPriceId, usdCentsForPriceId, subscriptionForPriceId, starterProductForPriceId } from './paddle/priceIds.js';
export { verifyPaddleSignature } from './paddle/signature.js';
export { clampPaddleQuantity, MIN_PADDLE_QUANTITY, MAX_PADDLE_QUANTITY } from './paddle/webhookRoute.js';
export type { PaddleDeps } from './paddle/types.js';

import type { PaddleDeps } from './paddle/types.js';

/**
 * Register Paddle routes:
 *   POST /shop/paddle/checkout  — player creates checkout session (JWT auth required)
 *   POST /paddle/webhook        — Paddle server callback (HMAC-SHA256 verified, no player auth)
 */
export function registerPaddleRoutes(app: FastifyInstance, deps: PaddleDeps): void {
  registerCheckoutRoute(app, deps);
  registerWebhookRoute(app, deps);
}
