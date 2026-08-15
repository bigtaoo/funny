// loadWorldsvcEnv() unit tests: pure env-var parsing, previously untested (0% coverage).
// Only touches the worldsvc-specific NW_WORLD_*/NW_*_INTERNAL_URL/NW_SLG_AUTO_SETTLE keys — base ServerEnv
// keys (NW_MONGO_URI etc.) are left alone since other test files in this suite (fileParallelism:false, same
// process) rely on whatever globalSetup/setupEnv already bridged into process.env.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadServerEnv } from '@nw/shared';
import { loadWorldsvcEnv } from '../src/config';

const ENV_KEYS = [
  'NW_WORLD_PORT',
  'NW_WORLD_HOST',
  'NW_WORLD_MONGO_URI',
  'NW_WORLD_MONGO_DB',
  'NW_WORLD_REDIS_URL',
  'NW_GATEWAY_INTERNAL_URL',
  'NW_COMMERCIAL_INTERNAL_URL',
  'NW_META_INTERNAL_URL',
  'NW_SOCIALSVC_INTERNAL_URL',
  'NW_ADMIN_INTERNAL_URL',
  'NW_SLG_AUTO_SETTLE',
] as const;

describe('loadWorldsvcEnv', () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  it('defaults: no NW_WORLD_*/internal-url/auto-settle env vars set -> documented fallbacks', () => {
    const env = loadWorldsvcEnv();
    const base = loadServerEnv();
    expect(env.port).toBe(18084);
    expect(env.host).toBe('0.0.0.0');
    expect(env.worldMongoUri).toBe(base.mongoUri);
    expect(env.worldMongoDb).toBe('notebook_wars_world');
    expect(env.redisUrl).toBeUndefined();
    expect(env.gatewayInternalUrl).toBeUndefined();
    expect(env.commercialInternalUrl).toBeUndefined();
    expect(env.metaInternalUrl).toBeUndefined();
    expect(env.socialsvcInternalUrl).toBeUndefined();
    expect(env.adminInternalUrl).toBeUndefined();
    expect(env.autoSettleSeasons).toBe(true);
  });

  it('every worldsvc env var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_WORLD_PORT = '19999';
    process.env.NW_WORLD_HOST = '127.0.0.1';
    process.env.NW_WORLD_MONGO_URI = 'mongodb://custom-world:27017/?replicaSet=rs0';
    process.env.NW_WORLD_MONGO_DB = 'custom_world_db';
    process.env.NW_WORLD_REDIS_URL = 'redis://world-redis:6379';
    process.env.NW_GATEWAY_INTERNAL_URL = 'http://gateway:8080';
    process.env.NW_COMMERCIAL_INTERNAL_URL = 'http://commercial:8082';
    process.env.NW_META_INTERNAL_URL = 'http://meta:18080';
    process.env.NW_SOCIALSVC_INTERNAL_URL = 'http://socialsvc:18089';
    process.env.NW_ADMIN_INTERNAL_URL = 'http://admin:18090';
    process.env.NW_SLG_AUTO_SETTLE = '0';

    const env = loadWorldsvcEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.worldMongoUri).toBe('mongodb://custom-world:27017/?replicaSet=rs0');
    expect(env.worldMongoDb).toBe('custom_world_db');
    expect(env.redisUrl).toBe('redis://world-redis:6379');
    expect(env.gatewayInternalUrl).toBe('http://gateway:8080');
    expect(env.commercialInternalUrl).toBe('http://commercial:8082');
    expect(env.metaInternalUrl).toBe('http://meta:18080');
    expect(env.socialsvcInternalUrl).toBe('http://socialsvc:18089');
    expect(env.adminInternalUrl).toBe('http://admin:18090');
    expect(env.autoSettleSeasons).toBe(false);
  });

  it('NW_SLG_AUTO_SETTLE set to anything other than "0" -> still true (only "0" opts out)', () => {
    process.env.NW_SLG_AUTO_SETTLE = '1';
    expect(loadWorldsvcEnv().autoSettleSeasons).toBe(true);
  });
});
