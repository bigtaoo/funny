// POST /paddle/webhook (2026-08-11 split, see paddle.ts's header). Paddle server-side event callback —
// no player auth, HMAC-SHA256 verified. Depends on priceIds.ts + signature.ts; zero dependency on
// checkoutRoute.ts (the two routes never call each other).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mirrorCoins, mirrorWalletFrom, deliverOrder } from '../economy.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import { coinsForPriceId, starterProductForPriceId, subscriptionForPriceId, usdCentsForPriceId } from './priceIds.js';
import { verifyPaddleSignature } from './signature.js';
import type { PaddleDeps } from './types.js';

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

/** Registers POST /paddle/webhook (own child plugin scope, for its raw-body content-type parser) on `app`. */
export function registerWebhookRoute(app: FastifyInstance, deps: PaddleDeps): void {
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
