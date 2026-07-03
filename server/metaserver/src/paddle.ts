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
//   NW_PADDLE_SANDBOX           "true" = use sandbox API (default false)
//
// Paddle webhook signature (h1 scheme):
//   Header:  Paddle-Signature: ts=<epoch>;h1=<hmac-sha256-hex>
//   Message: `${ts}:${rawBody}`
//   Key:     NW_PADDLE_WEBHOOK_SECRET

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IAP_TIERS } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { mirrorCoins } from './economy.js';
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
function coinsForPriceId(priceId: string): number {
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
    body: JSON.stringify({
      items: [{ priceId, quantity: 1 }],
      customData: { accountId },
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
    items?: Array<{ price?: { id?: string } }>;
  };
}

// ── Route registration ──────────────────────────────────────────────────────

interface PaddleDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
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
      if (!accountId) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' });

      const { tierId } = req.body as { tierId?: string };
      if (!tierId || !IAP_TIERS[tierId]) {
        return reply.code(400).send({ ok: false, error: 'INVALID_TIER' });
      }

      const priceId = priceIdForTier(tierId);
      if (!priceId) {
        return reply.code(503).send({ ok: false, error: 'PADDLE_NOT_CONFIGURED' });
      }

      let transactionId: string;
      try {
        transactionId = await createPaddleTransaction(priceId, accountId);
      } catch (e) {
        const msg = (e as Error).message;
        app.log.error(`paddle checkout error: ${msg}`);
        return reply.code(502).send({ ok: false, error: 'PADDLE_ERROR' });
      }

      return reply.send({ ok: true, transactionId });
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

        // Only process transaction.completed events.
        if (event.event_type !== 'transaction.completed') {
          return reply.code(200).send('ignored');
        }

        const txData = event.data;
        const transactionId = txData?.id;
        const status = txData?.status;
        const accountId = txData?.custom_data?.accountId;
        const priceId = txData?.items?.[0]?.price?.id;

        if (!transactionId || status !== 'completed' || !accountId || !priceId) {
          return reply.code(400).send('missing required fields');
        }

        const coins = coinsForPriceId(priceId);
        if (coins === 0) {
          app.log.warn(`paddle webhook: unknown priceId ${priceId} for tx ${transactionId}`);
          return reply.code(200).send('unknown price'); // 200 so Paddle does not retry
        }

        const result = await deps.commercial.paddleComplete({ accountId, transactionId, coins });
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
