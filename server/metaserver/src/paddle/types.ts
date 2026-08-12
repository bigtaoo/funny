// Paddle route deps (2026-08-11 split, see paddle.ts's header). Shared by checkoutRoute.ts and
// webhookRoute.ts; zero cross-file dependency.
import type { FastifyRequest } from 'fastify';
import type { Collections } from '@nw/shared';
import type { CommercialClient } from '../commercialClient.js';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';

export interface PaddleDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
  socialsvc?: MetaSocialsvcClient;
  /** JWT-verified accountId extractor (reuses meta auth). null = not logged in. */
  getAccountId(req: FastifyRequest): string | null;
}
