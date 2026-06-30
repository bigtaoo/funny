// bearerAuth security handler (fastify-openapi-glue securityHandlers).
// Verifies the JWT → writes req.accountId; throws an error with statusCode on failure (glue defaults to 401).
import type { FastifyRequest } from 'fastify';
import type { JwtConfig } from '@nw/shared';
import { ErrorCode, extractBearer, verifyToken } from '@nw/shared';

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

export function makeSecurityHandlers(jwt: JwtConfig) {
  return {
    bearerAuth(req: FastifyRequest) {
      const token = extractBearer(req.headers['authorization']);
      if (!token) throw unauthenticated('missing bearer token');
      try {
        req.accountId = verifyToken(token, jwt);
      } catch {
        throw unauthenticated('invalid token');
      }
    },
  };
}
