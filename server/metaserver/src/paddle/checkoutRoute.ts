// POST /shop/paddle/checkout (2026-08-11 split, see paddle.ts's header). Player-initiated checkout
// session creation — JWT auth required. Depends on priceIds.ts for the tier→priceId lookup; zero
// dependency on webhookRoute.ts (the two routes never call each other).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GROWTH_PACK_WINDOW_DAYS, IAP_TIERS, PRODUCT_STARTER_GROWTH } from '@nw/shared';
import { priceIdForTier } from './priceIds.js';
import type { PaddleDeps } from './types.js';

const PADDLE_PROD_API = 'https://api.paddle.com';
const PADDLE_SANDBOX_API = 'https://sandbox-api.paddle.com';

function paddleApiBase(): string {
  return process.env.NW_PADDLE_SANDBOX === 'true' ? PADDLE_SANDBOX_API : PADDLE_PROD_API;
}

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

/** Registers POST /shop/paddle/checkout on `app`. */
export function registerCheckoutRoute(app: FastifyInstance, deps: PaddleDeps): void {
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
}
