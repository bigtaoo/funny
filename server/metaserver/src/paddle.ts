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
// Paddle webhook signature (h1 scheme):
//   Header:  Paddle-Signature: ts=<epoch>;h1=<hmac-sha256-hex>
//   Message: `${ts}:${rawBody}`
//   Key:     NW_PADDLE_WEBHOOK_SECRET

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IAP_TIERS, IAP_TIERS_LIST, PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { mirrorCoins, mirrorWalletFrom, deliverOrder } from './economy.js';
import { getOrCreateSave } from './save.js';
import { nullMetaSocialsvcClient, type MetaSocialsvcClient } from './socialsvcClient.js';
import type { Collections } from '@nw/shared';

const PADDLE_PROD_API = 'https://api.paddle.com';
const PADDLE_SANDBOX_API = 'https://sandbox-api.paddle.com';

function paddleApiBase(): string {
  return process.env.NW_PADDLE_SANDBOX === 'true' ? PADDLE_SANDBOX_API : PADDLE_PROD_API;
}

// ── Price ID → coins mapping ────────────────────────────────────────────────

/**
 * Resolves a Paddle price ID to coins using NW_PADDLE_PRICE_IDS env var.
 * Format: "t499:pri_xxx,t999:pri_yyy,..."  (tier key → Paddle price ID)
 * Returns 0 if the price ID is not mapped.
 */
export function coinsForPriceId(priceId: string): number {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid === priceId && IAP_TIERS[tierKey]) return IAP_TIERS[tierKey]!;
  }
  return 0;
}

/**
 * Resolves a Paddle price ID to its real USD price (GACHA_DESIGN §13), via the same tier-key mapping as
 * coinsForPriceId. Returns 0 if the price ID is not mapped or the tier is unknown to IAP_TIERS_LIST.
 */
export function usdCentsForPriceId(priceId: string): number {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid === priceId) {
      const def = IAP_TIERS_LIST.find((t) => t.id === tierKey);
      if (def) return def.usdCents;
    }
  }
  return 0;
}

/**
 * Resolves a Paddle price ID to a subscription product via the same NW_PADDLE_PRICE_IDS mapping as
 * coinsForPriceId, using the reserved tier keys `monthly_card` / `year_card` (GACHA_DESIGN §5) instead
 * of an IAP_TIERS coin lookup. Returns null if the price ID isn't mapped to either.
 */
export function subscriptionForPriceId(priceId: string): 'monthly' | 'year' | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid !== priceId) continue;
    if (tierKey === 'monthly_card') return 'monthly';
    if (tierKey === 'year_card') return 'year';
  }
  return null;
}

/**
 * Resolves a Paddle price ID to a starter pack product (GACHA_DESIGN §6, ¥6/¥30 first-purchase-funnel
 * SKUs), same reserved-key mapping style as subscriptionForPriceId.
 */
export function starterProductForPriceId(priceId: string): 'starter_draw' | 'starter_growth' | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid !== priceId) continue;
    if (tierKey === 'starter_draw' || tierKey === 'starter_growth') return tierKey;
  }
  return null;
}

/**
 * Resolves a tier key to a Paddle price ID using NW_PADDLE_PRICE_IDS env var.
 * Returns null if the tier is not mapped.
 */
function priceIdForTier(tierId: string): string | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (tierKey === tierId && pid) return pid;
  }
  return null;
}

// ── Webhook signature verification ─────────────────────────────────────────

/**
 * Verify a Paddle webhook signature header.
 * Header format: `ts=<epoch>;h1=<hmac-sha256-hex>`
 * HMAC message:  `${ts}:${rawBody}`
 */
export function verifyPaddleSignature(secret: string, rawBody: string, header: string): boolean {
  const parts: Record<string, string> = {};
  for (const seg of header.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;

  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(h1, 'hex'));
  } catch {
    return false;
  }
}

// ── Paddle API: create transaction ─────────────────────────────────────────

interface PaddleTransactionResponse {
  data?: { id?: string };
  error?: { type?: string; detail?: string };
}

/**
 * Create a Paddle transaction via the Paddle Billing API.
 * Returns the transaction ID, which the client passes to Paddle.Checkout.open().
 */
async function createPaddleTransaction(priceId: string, accountId: string): Promise<string> {
  const apiKey = process.env.NW_PADDLE_API_KEY;
  if (!apiKey) throw new Error('NW_PADDLE_API_KEY not configured');

  const resp = await fetch(`${paddleApiBase()}/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    // Paddle Billing API uses snake_case field names — price_id / custom_data (NOT priceId / customData,
    // which the API silently rejects with a 400 "price_id is required" oneOf validation error).
    body: JSON.stringify({
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { accountId },
    }),
  });

  const json = (await resp.json()) as PaddleTransactionResponse;
  if (!resp.ok || !json.data?.id) {
    throw new Error(
      `Paddle create transaction failed: ${json.error?.detail ?? resp.status}`,
    );
  }
  return json.data.id;
}

// ── Webhook payload types ───────────────────────────────────────────────────

interface PaddleWebhookEvent {
  event_type?: string;
  data?: {
    id?: string; // transaction ID
    status?: string;
    custom_data?: { accountId?: string };
    items?: Array<{ price?: { id?: string }; quantity?: number }>;
    // adjustment.created/updated fields (refunds, GACHA_DESIGN §13): the refunded transaction id + action/status.
    transaction_id?: string;
    action?: string;
  };
}

// Buyer-adjustable quantity range on the Paddle checkout overlay (Dashboard price setting).
// Clamped again here so a forged/out-of-range webhook payload can't over-credit coins.
export const MIN_PADDLE_QUANTITY = 1;
export const MAX_PADDLE_QUANTITY = 5;

/**
 * Clamp a webhook-reported `items[0].quantity` to [MIN_PADDLE_QUANTITY, MAX_PADDLE_QUANTITY].
 * Non-numeric / missing / non-finite input defaults to 1 (the pre-quantity-support behavior).
 */
export function clampPaddleQuantity(rawQuantity: unknown): number {
  const n = Number(rawQuantity);
  const rounded = Number.isFinite(n) ? Math.round(n) : 1;
  return Math.min(MAX_PADDLE_QUANTITY, Math.max(MIN_PADDLE_QUANTITY, rounded));
}

// ── Route registration ──────────────────────────────────────────────────────

interface PaddleDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
  socialsvc?: MetaSocialsvcClient;
  /** JWT-verified accountId extractor (reuses meta auth). null = not logged in. */
  getAccountId(req: FastifyRequest): string | null;
}

/**
 * Register Paddle routes:
 *   POST /shop/paddle/checkout  — player creates checkout session (JWT auth required)
 *   POST /paddle/webhook        — Paddle server callback (HMAC-SHA256 verified, no player auth)
 */
export function registerPaddleRoutes(app: FastifyInstance, deps: PaddleDeps): void {
  // ── POST /shop/paddle/checkout ─────────────────────────────────────────────
  app.post<{ Body: { tierId?: string } }>(
    '/shop/paddle/checkout',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const accountId = deps.getAccountId(req);
      if (!accountId) {
        return reply
          .code(401)
          .send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'login required' } });
      }

      const { tierId } = req.body as { tierId?: string };
      // tierId is either a coin tier (IAP_TIERS), one of the subscription products (GACHA_DESIGN §5), or
      // one of the starter packs (GACHA_DESIGN §6) — all three share the same checkout+webhook plumbing
      // but aren't coin-tier priced.
      const isSubscription = tierId === 'monthly_card' || tierId === 'year_card';
      const isStarter = tierId === 'starter_draw' || tierId === PRODUCT_STARTER_GROWTH;
      if (!tierId || (!IAP_TIERS[tierId] && !isSubscription && !isStarter)) {
        return reply
          .code(400)
          .send({ ok: false, error: { code: 'INVALID_TIER', message: 'unknown product' } });
      }

      if (isSubscription) {
        // Refuse before charging when a card is already active (single-slot gate, same rule
        // subscriptionCardBuy enforces at grant time) — never take payment for a purchase the
        // server will end up refusing to grant.
        const wallet = await deps.commercial.getWallet(accountId);
        if (wallet && wallet.subscriptionExpiry > deps.now()) {
          return reply
            .code(400)
            .send({ ok: false, error: { code: 'ALREADY_ACTIVE', message: 'subscription already active' } });
        }
      }

      if (isStarter) {
        // Same once-per-account (+ growth pack's first-N-days window) pre-checks the direct /starter/buy
        // route enforces — refuse before charging rather than take payment for a grant the server will
        // end up refusing (mirrors the subscription pre-check above).
        const wallet = await deps.commercial.getWallet(accountId);
        if (wallet?.starterUsed?.includes(tierId)) {
          return reply
            .code(400)
            .send({ ok: false, error: { code: 'ALREADY_PURCHASED', message: 'starter pack already purchased' } });
        }
        if (tierId === PRODUCT_STARTER_GROWTH) {
          const acct = await deps.cols.accounts.findOne({ _id: accountId });
          if (acct && deps.now() - acct.createdAt > GROWTH_PACK_WINDOW_DAYS * 86400000) {
            return reply
              .code(400)
              .send({ ok: false, error: { code: 'NO_PERMISSION', message: 'growth pack window closed' } });
          }
        }
      }

      const priceId = priceIdForTier(tierId);
      if (!priceId) {
        return reply.code(503).send({
          ok: false,
          error: { code: 'PADDLE_NOT_CONFIGURED', message: 'paddle price ids unset' },
        });
      }

      let transactionId: string;
      try {
        transactionId = await createPaddleTransaction(priceId, accountId);
      } catch (e) {
        const msg = (e as Error).message;
        app.log.error(`paddle checkout error: ${msg}`);
        return reply
          .code(502)
          .send({ ok: false, error: { code: 'PADDLE_ERROR', message: 'checkout create failed' } });
      }

      // Client's ApiClient.request() unwraps the standard envelope and returns `json.data`, so the
      // transactionId MUST be nested under `data` (not top-level) or the client destructure throws.
      return reply.send({ ok: true, data: { transactionId } });
    },
  );

  // ── POST /paddle/webhook ───────────────────────────────────────────────────
  // Raw body needed for signature verification; Fastify parses JSON by default so we override the
  // application/json parser to capture the raw string. This MUST be encapsulated in its own plugin
  // scope: registering the parser on the shared `app` would replace the global JSON parser for every
  // route and impose its 64KB bodyLimit app-wide (e.g. /replay/share's 2MB blobs → Fastify 413 before
  // the app-layer 400 ever fires). A child context confines both the parser and its limit to this route.
  app.register(async (webhook) => {
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1024 * 64 },
      (_req, body, done) => {
        // Store raw string on req for signature check; also parse for handler use.
        (_req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
        try {
          done(null, JSON.parse(body as string));
        } catch (e) {
          done(e as Error);
        }
      },
    );

    webhook.post(
      '/paddle/webhook',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const secret = process.env.NW_PADDLE_WEBHOOK_SECRET;
        if (!secret) return reply.code(503).send('paddle webhook not configured');

        const sigHeader = (req.headers['paddle-signature'] as string) ?? '';
        const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';

        if (!verifyPaddleSignature(secret, rawBody, sigHeader)) {
          return reply.code(400).send('invalid signature');
        }

        const event = req.body as PaddleWebhookEvent;
        const txData = event.data;

        // Refund (GACHA_DESIGN §13, ADR-045): Paddle Billing reports refunds as adjustment events, not a
        // transaction.* event — approved refund-action adjustments decrement totalRechargeCents by exactly
        // what that transaction originally credited (commercial looks it up by transactionId). Already-claimed
        // reward tiers are not revoked, only future tier eligibility is affected.
        if (event.event_type === 'adjustment.created' || event.event_type === 'adjustment.updated') {
          if (txData?.action === 'refund' && txData.status === 'approved' && txData.transaction_id) {
            await deps.commercial.paddleRefund({ transactionId: txData.transaction_id });
          }
          return reply.code(200).send('processed');
        }

        // Only transaction.completed credits coins; every other transaction.* event (payment_failed,
        // canceled, past_due, …) is logged for support/CS lookup ("why didn't this payment go through")
        // instead of being silently dropped (COMMERCIAL_DESIGN.md §10.4).
        if (event.event_type !== 'transaction.completed') {
          if (event.event_type?.startsWith('transaction.') && txData?.id) {
            await deps.commercial.recordPaddleEvent({
              transactionId: txData.id,
              eventType: event.event_type,
              status: txData.status,
              accountId: txData.custom_data?.accountId,
              rawEvent: rawBody,
            });
          }
          return reply.code(200).send('ignored');
        }

        const transactionId = txData?.id;
        const status = txData?.status;
        const accountId = txData?.custom_data?.accountId;
        const priceId = txData?.items?.[0]?.price?.id;
        const rawQuantity = txData?.items?.[0]?.quantity;

        if (!transactionId || status !== 'completed' || !accountId || !priceId) {
          return reply.code(400).send('missing required fields');
        }

        // Monthly/year card (GACHA_DESIGN §5): grants a subscription instead of coins. Uses the Paddle
        // transactionId as the orderId, so a redelivered webhook (Paddle at-least-once) is idempotent the
        // same way paddleComplete dedupes coin recharges on `paddle:${transactionId}`.
        const subscriptionProduct = subscriptionForPriceId(priceId);
        if (subscriptionProduct) {
          // These SKUs aren't meant to be quantity-adjustable (buying N cards isn't a supported grant
          // shape) — the Paddle dashboard price should disable quantity selection; log if it ever shows up.
          if (typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) && rawQuantity !== 1) {
            app.log.warn(`paddle webhook: subscription tx ${transactionId} reported quantity ${rawQuantity}, ignoring (grants exactly one card)`);
          }
          const orderId = `paddle:${transactionId}`;
          // Real money via Paddle (web-only store) — tags the 'web' recharged bucket (ADR-020), not the free pool.
          const result = subscriptionProduct === 'monthly'
            ? await deps.commercial.monthlyCardBuy({ accountId, orderId, rechargePlatform: 'paddle' })
            : await deps.commercial.yearCardBuy({ accountId, orderId, rechargePlatform: 'paddle' });
          if (!result.ok) {
            // Real money already changed hands but the grant was refused (e.g. an extreme same-instant
            // race against another purchase slipping past the checkout-time pre-check) — log for CS/refund
            // lookup instead of silently dropping it.
            app.log.error(`paddle webhook: subscription grant failed ${result.error} tx=${transactionId}`);
            await deps.commercial.recordPaddleEvent({
              transactionId, eventType: 'transaction.completed', status, accountId, rawEvent: rawBody,
            });
            return reply.code(200).send('processed');
          }
          const w = await deps.commercial.getWallet(accountId, 'web'); // Paddle is web-only (ADR-020)
          if (w) await mirrorWalletFrom(deps.cols, accountId, w, deps.now());
          return reply.code(200).send('ok');
        }

        // Starter pack (GACHA_DESIGN §6, ¥6/¥30): once-per-account, may deliver loot-box items
        // (starter_draw) alongside coins/card (starter_growth). Same idempotency shape as the
        // subscription branch above.
        const starterProduct = starterProductForPriceId(priceId);
        if (starterProduct) {
          if (typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) && rawQuantity !== 1) {
            app.log.warn(`paddle webhook: starter pack tx ${transactionId} reported quantity ${rawQuantity}, ignoring (grants exactly one pack)`);
          }
          const orderId = `paddle:${transactionId}`;
          // Real money via Paddle (web-only store) — tags the 'web' recharged bucket (ADR-020) for starter_growth's coins.
          const result = await deps.commercial.starterBuy({ accountId, productId: starterProduct, orderId, rechargePlatform: 'paddle' });
          if (!result.ok) {
            // Real money already changed hands but the grant was refused (e.g. an extreme same-instant
            // race, or the checkout-time pre-check window closing between checkout and webhook) — log
            // for CS/refund lookup instead of silently dropping it.
            app.log.error(`paddle webhook: starter pack grant failed ${result.error} tx=${transactionId}`);
            await deps.commercial.recordPaddleEvent({
              transactionId, eventType: 'transaction.completed', status, accountId, rawEvent: rawBody,
            });
            return reply.code(200).send('processed');
          }
          if (result.results.length > 0) {
            await deliverOrder(
              deps.cols, deps.commercial, deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
              { _id: orderId, kind: 'starter', result: { results: result.results, poolId: 'standard' } },
              result.coinsAfter, null, deps.now(),
            );
          }
          const w = await deps.commercial.getWallet(accountId, 'web'); // Paddle is web-only (ADR-020)
          if (w) await mirrorWalletFrom(deps.cols, accountId, w, deps.now());
          return reply.code(200).send('ok');
        }

        const unitCoins = coinsForPriceId(priceId);
        if (unitCoins === 0) {
          app.log.warn(`paddle webhook: unknown priceId ${priceId} for tx ${transactionId}`);
          return reply.code(200).send('unknown price'); // 200 so Paddle does not retry
        }

        // Clamp to the checkout overlay's allowed range (MIN/MAX_PADDLE_QUANTITY) so a malformed or
        // forged payload can't over-credit. A missing `quantity` field defaults to 1 silently (older
        // event shape); a present-but-out-of-range value is clamped AND logged for CS lookup.
        const clampedQuantity = clampPaddleQuantity(rawQuantity);
        if (
          typeof rawQuantity === 'number' &&
          Number.isFinite(rawQuantity) &&
          (rawQuantity < MIN_PADDLE_QUANTITY || rawQuantity > MAX_PADDLE_QUANTITY)
        ) {
          app.log.warn(
            `paddle webhook: quantity ${rawQuantity} out of range for tx ${transactionId}, clamped to ${clampedQuantity}`,
          );
        }
        const coins = unitCoins * clampedQuantity;
        const usdCents = usdCentsForPriceId(priceId) * clampedQuantity;

        const result = await deps.commercial.paddleComplete({ accountId, transactionId, coins, usdCents });
        if (!result.ok) {
          app.log.error(`paddle paddleComplete failed: ${result.error} tx=${transactionId}`);
          return reply.code(200).send('processed'); // still 200 to prevent retry loops on business errors
        }

        await mirrorCoins(deps.cols, accountId, result.coinsAfter, deps.now());
        return reply.code(200).send('ok');
      },
    );
  });
}
