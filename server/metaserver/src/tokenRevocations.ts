// metaserver side of the token revocation list (shared/src/tokenRevocation.ts, ACCOUNT_DESIGN §C5-b).
// meta owns the `tokenRevocations` collection: the purge job writes a row when it claims an account, the
// internal route below serves it to the other verifying processes, and meta's own bearerAuth reads it
// through the same in-memory TokenRevocationList (fed from Mongo directly instead of over HTTP).
import type { FastifyInstance } from 'fastify';
import type { Collections, TokenRevocationPage, TokenRevocationSource } from '@nw/shared';
import { TOKEN_REVOCATIONS_PATH, TOKEN_REVOCATION_RETENTION_MS, createLogger } from '@nw/shared';

const log = createLogger('meta:token-revocations');

/**
 * Revoke every token the account holds right now. Idempotent: a re-run (purge retry) keeps the first
 * revokedAt, so tokens issued in between are not re-legitimised and the TTL is not pushed out.
 */
export async function revokeAccountTokens(cols: Collections, accountId: string, now: number): Promise<void> {
  await cols.tokenRevocations.updateOne(
    { _id: accountId },
    {
      $setOnInsert: {
        revokedAt: now,
        reason: 'account_purged',
        expireAt: new Date(now + TOKEN_REVOCATION_RETENTION_MS),
      },
    },
    { upsert: true },
  );
}

/** Rows with revokedAt >= since. `asOf` is read before the query so a row committed meanwhile is re-read next poll. */
export async function readTokenRevocations(cols: Collections, since: number, now: number): Promise<TokenRevocationPage> {
  const rows = await cols.tokenRevocations
    .find({ revokedAt: { $gte: since } }, { projection: { revokedAt: 1 } })
    .toArray();
  return { asOf: now, revocations: rows.map((r) => ({ accountId: r._id, revokedAt: r.revokedAt })) };
}

/** Local (same-database) source for meta's own TokenRevocationList; a Mongo error is a failed poll, not a throw. */
export function localTokenRevocationSource(cols: Collections, now: () => number): TokenRevocationSource {
  return async (since) => {
    try {
      return await readTokenRevocations(cols, since, now());
    } catch (e) {
      log.warn('token revocation read failed', { err: (e as Error).message });
      return null;
    }
  };
}

export function registerTokenRevocationRoutes(
  app: FastifyInstance,
  ctx: { cols: Collections; now: () => number; authed: (h: Record<string, string | string[] | undefined>) => boolean },
): void {
  // ── GET /internal/auth/token-revocations?since=<epoch ms> ─────────────
  // Polled once a minute by worldsvc / socialsvc / auctionsvc / analyticsvc / gateway (SERVER_API_INTERNAL §15).
  app.get(TOKEN_REVOCATIONS_PATH, async (req, reply) => {
    if (!ctx.authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const raw = (req.query as { since?: string }).since;
    const since = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(since) || since < 0) {
      return reply.code(400).send({ ok: false, error: 'since must be a non-negative epoch ms' });
    }
    return reply.send(await readTokenRevocations(ctx.cols, since, ctx.now()));
  });
}
