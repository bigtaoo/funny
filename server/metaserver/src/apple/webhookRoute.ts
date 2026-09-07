// POST /iap/apple/notifications — App Store Server Notifications V2 (2026-09-07).
//
// Apple pushes subscription lifecycle and refund events here: renewals that happen entirely inside
// Apple's systems with no round trip through the app, refunds, revocations, and requests for
// consumption data. This is the counterpart to /paddle/webhook for the iOS channel, which previously
// had none — renewals were discovered only by the client re-reading its receipt at cold start.
//
// ── Why this route is so thin ──
// It does not verify anything. Apple signs the payload as a JWS, and checking that signature needs
// the pinned Apple root certificates plus the app's bundle/app id — all of which live in commercial,
// together with the wallet the notification would move. Forwarding the payload verbatim keeps
// "who may grant money" and "who decides a payload is genuine" in one service instead of two.
// Contrast /paddle/webhook, which verifies in place: its HMAC secret is metaserver's own.
//
// ── Why it always answers 200 ──
// A non-2xx makes Apple redeliver, which only helps if a retry could succeed. A forged payload, a
// notification for another app, or one we cannot route to an account are all permanent conditions —
// redelivering them wastes Apple's retries and buries the real failures. Every one of those is
// recorded on the commercial side (the appleNotifications collection) instead, which is where anyone
// investigating would look. Same reasoning the Paddle webhook already documents.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CommercialClient } from '../commercialClient.js';

export interface AppleWebhookDeps {
  commercial: CommercialClient;
}

/** Registers POST /iap/apple/notifications on `app`. */
export function registerAppleWebhookRoute(app: FastifyInstance, deps: AppleWebhookDeps): void {
  app.post('/iap/apple/notifications', async (req: FastifyRequest, reply: FastifyReply) => {
    const { signedPayload } = (req.body ?? {}) as { signedPayload?: unknown };
    if (typeof signedPayload !== 'string' || signedPayload.length === 0) {
      // Not shaped like an Apple notification at all. 400 rather than 200: this is not something
      // Apple sent, so there is no redelivery to suppress.
      return reply.code(400).send('missing signedPayload');
    }

    try {
      const result = await deps.commercial.appleNotification({ signedPayload });
      if (!result.ok) {
        // Apple unconfigured, or commercial refused — logged for operators, still 200 for Apple.
        app.log.error(`apple notification not processed: ${result.error}`);
        return reply.code(200).send('unprocessed');
      }
      if (result.outcome !== 'granted' && result.outcome !== 'ignored') {
        // 'unlinked' (a charge we cannot attribute) and 'unverified' (a payload we could not trust)
        // both mean a player may have paid for something they did not get — worth a log line each.
        app.log.warn(`apple notification outcome=${result.outcome}`);
      }
      return reply.code(200).send(result.outcome);
    } catch (e) {
      // commercial unreachable is the one genuinely retryable case, so let Apple resend.
      app.log.error(`apple notification failed: ${(e as Error).message}`);
      return reply.code(503).send('unavailable');
    }
  });
}
