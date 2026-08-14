// loadSocialsvcEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern as
// admin/gateway/gameserver/botsvc/auctionsvc's config.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadSocialsvcEnv } from '../src/config';

const ENV_KEYS = [
  'NW_SOCIAL_PORT', 'NW_SOCIAL_HOST', 'NW_SOCIAL_MONGO_URI', 'NW_SOCIAL_MONGO_DB',
  'NW_GATEWAY_INTERNAL_URL', 'NW_META_INTERNAL_URL', 'NW_ADMIN_INTERNAL_URL',
  // Base ServerEnv vars loadServerEnv() itself reads (must be present or it throws).
  'NW_JWT_SECRET', 'NW_MONGO_URI', 'NW_MONGO_DB', 'NW_INTERNAL_KEY',
] as const;

describe('loadSocialsvcEnv', () => {
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

  it('defaults: no social-specific env vars set -> documented fallbacks', () => {
    const env = loadSocialsvcEnv();
    expect(env.port).toBe(8085);
    expect(env.host).toBe('0.0.0.0');
    expect(env.socialMongoUri).toBe(env.mongoUri); // defaults to the main instance
    expect(env.socialMongoDb).toBe('nw_social');
    expect(env.gatewayInternalUrl).toBeUndefined();
    expect(env.metaInternalUrl).toBeUndefined();
    expect(env.adminInternalUrl).toBeUndefined();
  });

  it('every social-specific var set -> all threaded through verbatim', () => {
    process.env.NW_SOCIAL_PORT = '19999';
    process.env.NW_SOCIAL_HOST = '127.0.0.1';
    process.env.NW_SOCIAL_MONGO_URI = 'mongodb://social-db:27017';
    process.env.NW_SOCIAL_MONGO_DB = 'nw_social_prod';
    process.env.NW_GATEWAY_INTERNAL_URL = 'http://gateway:8090';
    process.env.NW_META_INTERNAL_URL = 'http://meta:18080';
    process.env.NW_ADMIN_INTERNAL_URL = 'http://admin:18083';

    const env = loadSocialsvcEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.socialMongoUri).toBe('mongodb://social-db:27017');
    expect(env.socialMongoDb).toBe('nw_social_prod');
    expect(env.gatewayInternalUrl).toBe('http://gateway:8090');
    expect(env.metaInternalUrl).toBe('http://meta:18080');
    expect(env.adminInternalUrl).toBe('http://admin:18083');
  });

  it('falsy empty-string overrides fall back to undefined, not the empty string itself', () => {
    process.env.NW_GATEWAY_INTERNAL_URL = '';
    process.env.NW_META_INTERNAL_URL = '';
    process.env.NW_ADMIN_INTERNAL_URL = '';
    const env = loadSocialsvcEnv();
    expect(env.gatewayInternalUrl).toBeUndefined();
    expect(env.metaInternalUrl).toBeUndefined();
    expect(env.adminInternalUrl).toBeUndefined();
  });
});
