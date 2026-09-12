// loadCommercialEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern
// as admin/gateway/gameserver/botsvc/auctionsvc/socialsvc's config.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DEV_MONGO_URI } from '@nw/shared';
import { loadCommercialEnv } from '../src/config';

const ENV_KEYS = [
  'NW_COMM_PORT', 'NW_COMM_HOST', 'NW_COMM_MONGO_URI', 'NW_COMM_MONGO_DB', 'NW_REDIS_URL',
  // Base ServerEnv vars loadServerEnv() itself reads (must be present or it throws).
  'NW_JWT_SECRET', 'NW_MONGO_URI', 'NW_MONGO_DB', 'NW_INTERNAL_KEY',
] as const;

describe('loadCommercialEnv', () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
    // Its own login is required now, not defaulted (ADR-090) — every case needs it present.
    process.env.NW_COMM_MONGO_URI = 'mongodb://its-own-host:27017/?replicaSet=rs0';
    process.env.NW_JWT_SECRET = 'base-secret';
    process.env.NW_MONGO_URI = 'mongodb://127.0.0.1:27017';
    process.env.NW_MONGO_DB = 'nw_base';
    process.env.NW_INTERNAL_KEY = 'base-internal-key';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  it('defaults: no commercial-specific env vars set -> documented fallbacks', () => {
    const env = loadCommercialEnv();
    expect(env.port).toBe(18082);
    expect(env.host).toBe('0.0.0.0');
    expect(env.commMongoUri).toBe('mongodb://its-own-host:27017/?replicaSet=rs0'); // its OWN login, threaded through untouched
    expect(env.commMongoDb).toBe('notebook_wars_commercial');
    expect(env.redisUrl).toBeNull();
  });

  it('every commercial-specific var set -> all threaded through verbatim', () => {
    process.env.NW_COMM_PORT = '19999';
    process.env.NW_COMM_HOST = '127.0.0.1';
    process.env.NW_COMM_MONGO_URI = 'mongodb://comm-db:27017';
    process.env.NW_COMM_MONGO_DB = 'nw_commercial_prod';
    process.env.NW_REDIS_URL = 'redis://redis:6379';

    const env = loadCommercialEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.commMongoUri).toBe('mongodb://comm-db:27017');
    expect(env.commMongoDb).toBe('nw_commercial_prod');
    expect(env.redisUrl).toBe('redis://redis:6379');
  });

  it("with its own Mongo URI unset, falls back to the local dev Mongo — never to metaserver's login (ADR-090)", () => {
    // Until 2026-09-12 this line read `?? base.mongoUri`, so an unset NW_COMM_MONGO_URI silently handed this
    // service metaserver's connection string — and on the deployed cluster that login could read and write
    // every database, which is precisely the isolation this was supposed to provide. The replacement
    // fallback is a HOST nobody has grants on, so a misconfigured deployment dies on a refused connection
    // instead of quietly opening someone else's data.
    delete process.env.NW_COMM_MONGO_URI;
    expect(loadCommercialEnv().commMongoUri).toBe(DEV_MONGO_URI);
  });
});
