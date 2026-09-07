// POST /iap/apple/notifications — the route's contract with Apple.
//
// The route itself decides almost nothing (verification and granting both happen in commercial), so
// what is worth pinning here is exactly the part Apple can see: which status code it gets back, and
// therefore whether it redelivers. Getting that wrong is invisible in normal operation and expensive
// when it matters — a route that 500s on a payload it will never accept turns one bad notification
// into days of retries, and one that 200s while commercial is down throws away real renewals.
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAppleWebhookRoute } from '../dist/apple/webhookRoute.js';
import type { CommercialClient } from '../dist/commercialClient.js';

type NotificationResult = Awaited<ReturnType<CommercialClient['appleNotification']>>;

/** Only the one method the route touches; the rest of CommercialClient is irrelevant here. */
function appWith(
  appleNotification: (args: { signedPayload: string }) => Promise<NotificationResult>,
): { app: FastifyInstance; seen: string[] } {
  const seen: string[] = [];
  const app = Fastify({ logger: false });
  registerAppleWebhookRoute(app, {
    commercial: {
      appleNotification: async (args) => {
        seen.push(args.signedPayload);
        return appleNotification(args);
      },
    } as unknown as CommercialClient,
  });
  return { app, seen };
}

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/iap/apple/notifications', payload });

describe('POST /iap/apple/notifications', () => {
  it('forwards the signed payload verbatim and answers 200', async () => {
    const { app, seen } = appWith(async () => ({ ok: true, outcome: 'granted' }));
    const res = await post(app, { signedPayload: 'ey.header.signature' });
    expect(res.statusCode).toBe(200);
    // Verbatim matters: the signature covers the exact bytes, so any reshaping here would make a
    // genuine notification unverifiable downstream.
    expect(seen).toEqual(['ey.header.signature']);
  });

  it.each(['unlinked', 'unverified', 'ignored', 'consumption_no_consent'])(
    'answers 200 for outcome=%s — none of these get better on a redelivery',
    async (outcome) => {
      const { app } = appWith(async () => ({ ok: true, outcome }));
      const res = await post(app, { signedPayload: 'ey.x.y' });
      expect(res.statusCode).toBe(200);
    },
  );

  it('answers 200 when commercial refuses to process it', async () => {
    // e.g. Apple unconfigured. Apple retrying cannot fix our configuration, so do not ask it to.
    const { app } = appWith(async () => ({ ok: false, error: 'BAD_REQUEST' }));
    const res = await post(app, { signedPayload: 'ey.x.y' });
    expect(res.statusCode).toBe(200);
  });

  it('answers 503 when commercial is unreachable — the one case a retry can fix', async () => {
    const { app } = appWith(async () => { throw new Error('ECONNREFUSED'); });
    const res = await post(app, { signedPayload: 'ey.x.y' });
    expect(res.statusCode).toBe(503);
  });

  it.each([{}, { signedPayload: '' }, { signedPayload: 42 }, { notTheField: 'x' }])(
    'rejects a body that is not an Apple notification (%j)',
    async (body) => {
      const { app, seen } = appWith(async () => ({ ok: true, outcome: 'granted' }));
      const res = await post(app, body);
      expect(res.statusCode).toBe(400);
      expect(seen).toEqual([]); // never reaches commercial
    },
  );

  it('needs no player authentication — Apple has no bearer token to send', async () => {
    const { app } = appWith(async () => ({ ok: true, outcome: 'granted' }));
    const res = await post(app, { signedPayload: 'ey.x.y' });
    expect(res.statusCode).not.toBe(401);
  });
});
