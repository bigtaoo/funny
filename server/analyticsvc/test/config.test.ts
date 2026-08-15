// loadAnalyticssvcEnv() unit tests: pure env-var parsing, previously untested (0% coverage).
// Only touches the analyticsvc-specific NW_ANALYTICS_* keys — base ServerEnv keys (NW_MONGO_URI etc.)
// are left alone since other test files in this suite (fileParallelism:false, same process) rely on
// whatever globalSetup/setupEnv already bridged into process.env.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadServerEnv } from '@nw/shared';
import { loadAnalyticssvcEnv } from '../src/config';

const ENV_KEYS = [
  'NW_ANALYTICS_PORT',
  'NW_ANALYTICS_HOST',
  'NW_ANALYTICS_MONGO_URI',
  'NW_ANALYTICS_MONGO_DB',
] as const;

describe('loadAnalyticssvcEnv', () => {
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

  it('defaults: no NW_ANALYTICS_* env vars set -> documented fallbacks', () => {
    const env = loadAnalyticssvcEnv();
    const base = loadServerEnv();
    expect(env.port).toBe(18085);
    expect(env.host).toBe('0.0.0.0');
    expect(env.analyticsMongoUri).toBe(base.mongoUri);
    expect(env.analyticsMongoDb).toBe('notebook_wars_analytics');
  });

  it('every NW_ANALYTICS_* env var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_ANALYTICS_PORT = '19999';
    process.env.NW_ANALYTICS_HOST = '127.0.0.1';
    process.env.NW_ANALYTICS_MONGO_URI = 'mongodb://custom-analytics:27017/?replicaSet=rs0';
    process.env.NW_ANALYTICS_MONGO_DB = 'custom_analytics_db';

    const env = loadAnalyticssvcEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.analyticsMongoUri).toBe('mongodb://custom-analytics:27017/?replicaSet=rs0');
    expect(env.analyticsMongoDb).toBe('custom_analytics_db');
  });

  it('also threads through base ServerEnv fields (jwtSecret, mongoDb, internalKey)', () => {
    const env = loadAnalyticssvcEnv();
    const base = loadServerEnv();
    expect(env.jwtSecret).toBe(base.jwtSecret);
    expect(env.mongoDb).toBe(base.mongoDb);
    expect(env.internalKey).toBe(base.internalKey);
  });
});
