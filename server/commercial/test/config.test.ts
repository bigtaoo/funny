// loadCommercialEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern
// as admin/gateway/gameserver/botsvc/auctionsvc/socialsvc's config.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
    expect(env.commMongoUri).toBe(env.mongoUri); // defaults to the same instance as meta
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
});
