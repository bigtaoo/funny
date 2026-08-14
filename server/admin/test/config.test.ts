// loadAdminEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern as
// gameserver/test/config.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadAdminEnv } from '../src/config';

const ENV_KEYS = [
  'NW_ADMIN_PORT',
  'NW_ADMIN_HOST',
  'NW_ADMIN_JWT_SECRET',
  'NW_ADMIN_JWT_TTL',
  'NW_ADMIN_MONGO_URI',
  'NW_ADMIN_MONGO_DB',
  'NW_ADMIN_SEED_USER',
  'NW_ADMIN_SEED_PASS',
  'NW_META_BASE_URL',
  'NW_GATEWAY_INTERNAL_URL',
  'NW_MATCHSVC_INTERNAL_URL',
  'NW_ANALYTICS_BASE_URL',
  'NW_WORLD_INTERNAL_URL',
  'NW_AUCTION_INTERNAL_URL',
  'NW_SOCIALSVC_INTERNAL_URL',
  'NW_ADMIN_SAMPLE_MS',
  'NW_ADMIN_SNAPSHOT_TTL_SEC',
  // Base ServerEnv vars loadServerEnv() itself reads (must be present or it throws).
  'NW_JWT_SECRET',
  'NW_MONGO_URI',
  'NW_MONGO_DB',
  'NW_INTERNAL_KEY',
] as const;

describe('loadAdminEnv', () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
    // loadServerEnv() (the base ServerEnv this extends) throws on a missing jwtSecret/mongoUri/mongoDb/
    // internalKey with no fallback — supply the minimum it needs so loadAdminEnv() itself can be exercised.
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

  it('defaults: no admin-specific env vars set -> documented fallbacks', () => {
    const env = loadAdminEnv();
    expect(env.port).toBe(18083);
    expect(env.host).toBe('0.0.0.0');
    expect(env.adminJwtSecret).toBe('dev-insecure-admin-secret-change-me');
    expect(env.adminJwtTtl).toBe('8h');
    expect(env.adminMongoUri).toBe(env.mongoUri); // defaults to the same instance as meta
    expect(env.adminMongoDb).toBe('notebook_wars_admin');
    expect(env.seedUser).toBeNull();
    expect(env.seedPass).toBeNull();
    expect(env.metaBaseUrl).toBeNull();
    expect(env.gatewayInternalUrl).toBeNull();
    expect(env.matchsvcInternalUrl).toBeNull();
    expect(env.analyticsBaseUrl).toBeNull();
    expect(env.worldInternalUrl).toBeNull();
    expect(env.auctionInternalUrl).toBeNull();
    expect(env.socialInternalUrl).toBeNull();
    expect(env.sampleIntervalMs).toBe(30000);
    expect(env.snapshotTtlSec).toBe(14 * 24 * 3600);
  });

  it('every admin-specific var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_ADMIN_PORT = '19999';
    process.env.NW_ADMIN_HOST = '127.0.0.1';
    process.env.NW_ADMIN_JWT_SECRET = 'prod-admin-secret';
    process.env.NW_ADMIN_JWT_TTL = '2h';
    process.env.NW_ADMIN_MONGO_URI = 'mongodb://admin-db:27017';
    process.env.NW_ADMIN_MONGO_DB = 'nw_admin_prod';
    process.env.NW_ADMIN_SEED_USER = 'bootstrap';
    process.env.NW_ADMIN_SEED_PASS = 'bootstrap-pass';
    process.env.NW_META_BASE_URL = 'http://meta:18080';
    process.env.NW_GATEWAY_INTERNAL_URL = 'http://gateway:18081';
    process.env.NW_MATCHSVC_INTERNAL_URL = 'http://matchsvc:18091';
    process.env.NW_ANALYTICS_BASE_URL = 'http://analytics:18085';
    process.env.NW_WORLD_INTERNAL_URL = 'http://world:18090';
    process.env.NW_AUCTION_INTERNAL_URL = 'http://auction:18086';
    process.env.NW_SOCIALSVC_INTERNAL_URL = 'http://social:18084';
    process.env.NW_ADMIN_SAMPLE_MS = '5000';
    process.env.NW_ADMIN_SNAPSHOT_TTL_SEC = '3600';

    const env = loadAdminEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.adminJwtSecret).toBe('prod-admin-secret');
    expect(env.adminJwtTtl).toBe('2h');
    expect(env.adminMongoUri).toBe('mongodb://admin-db:27017');
    expect(env.adminMongoDb).toBe('nw_admin_prod');
    expect(env.seedUser).toBe('bootstrap');
    expect(env.seedPass).toBe('bootstrap-pass');
    expect(env.metaBaseUrl).toBe('http://meta:18080');
    expect(env.gatewayInternalUrl).toBe('http://gateway:18081');
    expect(env.matchsvcInternalUrl).toBe('http://matchsvc:18091');
    expect(env.analyticsBaseUrl).toBe('http://analytics:18085');
    expect(env.worldInternalUrl).toBe('http://world:18090');
    expect(env.auctionInternalUrl).toBe('http://auction:18086');
    expect(env.socialInternalUrl).toBe('http://social:18084');
    expect(env.sampleIntervalMs).toBe(5000);
    expect(env.snapshotTtlSec).toBe(3600);
  });
});
