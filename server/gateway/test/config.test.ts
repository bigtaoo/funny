// loadGatewayEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern as
// gameserver/test/config.test.ts and admin/test/config.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadGatewayEnv } from '../src/config';

const ENV_KEYS = [
  'NW_GW_PORT',
  'NW_GW_HOST',
  'NW_GW_INTERNAL_PORT',
  'NW_META_BASE_URL',
  'NW_MATCHSVC_INTERNAL_URL',
  'NW_GW_REDIS_URL',
  'NW_SOCIALSVC_INTERNAL_URL',
  'NW_GW_RATE_LIMIT_TIGHT',
  'NW_GW_RATE_LIMIT_STANDARD',
  // Base ServerEnv vars loadServerEnv() itself reads (must be present or it throws).
  'NW_JWT_SECRET',
  'NW_MONGO_URI',
  'NW_MONGO_DB',
  'NW_INTERNAL_KEY',
] as const;

describe('loadGatewayEnv', () => {
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

  it('defaults: no gateway-specific env vars set -> documented fallbacks', () => {
    const env = loadGatewayEnv();
    expect(env.port).toBe(8082);
    expect(env.host).toBe('0.0.0.0');
    expect(env.internalPort).toBe(8090);
    expect(env.metaBaseUrl).toBeNull();
    expect(env.matchsvcInternalUrl).toBeNull();
    expect(env.redisUrl).toBeUndefined();
    expect(env.socialsvcInternalUrl).toBeNull();
    expect(env.rateLimitTight).toBe(10);
    expect(env.rateLimitStandard).toBe(20);
  });

  it('every gateway-specific var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_GW_PORT = '19999';
    process.env.NW_GW_HOST = '127.0.0.1';
    process.env.NW_GW_INTERNAL_PORT = '19090';
    process.env.NW_META_BASE_URL = 'http://meta:18080';
    process.env.NW_MATCHSVC_INTERNAL_URL = 'http://matchsvc:18091';
    process.env.NW_GW_REDIS_URL = 'redis://redis:6379';
    process.env.NW_SOCIALSVC_INTERNAL_URL = 'http://social:18084';
    process.env.NW_GW_RATE_LIMIT_TIGHT = '5';
    process.env.NW_GW_RATE_LIMIT_STANDARD = '15';

    const env = loadGatewayEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.internalPort).toBe(19090);
    expect(env.metaBaseUrl).toBe('http://meta:18080');
    expect(env.matchsvcInternalUrl).toBe('http://matchsvc:18091');
    expect(env.redisUrl).toBe('redis://redis:6379');
    expect(env.socialsvcInternalUrl).toBe('http://social:18084');
    expect(env.rateLimitTight).toBe(5);
    expect(env.rateLimitStandard).toBe(15);
  });

  it('NW_GW_REDIS_URL="" (falsy empty string) -> undefined, not the empty string itself', () => {
    process.env.NW_GW_REDIS_URL = '';
    expect(loadGatewayEnv().redisUrl).toBeUndefined();
  });
});
