// bearerAuth security handler (fastify-openapi-glue securityHandlers).
// Verifies the JWT → writes req.accountId; throws an error with statusCode on failure (glue defaults to 401).
//
// Also the single place where a **sliding renewal** happens (ACCOUNT_DESIGN.md §5): every
// authenticated metaserver request whose token is inside its last TOKEN_RENEW_WINDOW_MS gets a
// freshly-signed one back in the `x-nw-token` response header, which the client adopts and
// persists. Deliberately metaserver-only — worldsvc/socialsvc/auctionsvc/analyticsvc verify the
// same JWT but never connect to the accounts database (see each `httpApi.ts` header), so they have
// no basis for deciding whether the account behind the token still exists; they inherit the
// renewed token as soon as the client swaps it in.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtConfig, TokenPayload } from '@nw/shared';
import {
  ErrorCode,
  RENEWED_TOKEN_HEADER,
  TOKEN_RENEW_WINDOW_MS,
  extractBearer,
  signToken,
  verifyTokenPayload,
} from '@nw/shared';

declare module 'fastify' {
  interface FastifyRequest {
    accountId?: string;
  }
}

interface AuthError extends Error {
  statusCode: number;
}

function unauthenticated(message: string): AuthError {
  const e = new Error(message) as AuthError;
  e.name = ErrorCode.UNAUTHENTICATED;
  e.statusCode = 401;
  return e;
}

/**
 * Attach a renewed token when this one is close to expiring. No-ops when:
 *   · there is no `reply` — a caller invoking bearerAuth for its accountId only (and unit tests);
 *   · the token carries no `exp` — not something signToken can produce, but a hand-made token could;
 *   · `exp` is already in the past — unreachable via verifyTokenPayload (jsonwebtoken rejects an
 *     expired token before we get here) and left as a guard so a future clockTolerance cannot turn
 *     an expired token into a renewed one, which would make the 30d ceiling meaningless.
 */
function maybeRenewToken(
  payload: TokenPayload,
  jwt: JwtConfig,
  reply: FastifyReply | undefined,
  now: () => number,
): void {
  if (!reply || payload.exp === undefined) return;
  const remainingMs = payload.exp * 1000 - now();
  if (remainingMs <= 0 || remainingMs >= TOKEN_RENEW_WINDOW_MS) return;
  reply.header(RENEWED_TOKEN_HEADER, signToken(payload.sub, jwt));
}

export function makeSecurityHandlers(jwt: JwtConfig, now: () => number = () => Date.now()) {
  return {
    bearerAuth(req: FastifyRequest, reply?: FastifyReply) {
      const token = extractBearer(req.headers['authorization']);
      if (!token) throw unauthenticated('missing bearer token');
      let payload: TokenPayload;
      try {
        payload = verifyTokenPayload(token, jwt);
      } catch {
        throw unauthenticated('invalid token');
      }
      req.accountId = payload.sub;
      maybeRenewToken(payload, jwt, reply, now);
    },
  };
}
