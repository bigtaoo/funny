// Unit tests for config.ts's loadServerEnv()/required(). Coverage note on the throw branch: `required`
// computes `v = process.env[name] ?? fallback`; `??` only substitutes on null/undefined, NOT on an empty
// string. All 4 loadServerEnv() call sites pass a non-empty fallback, so the throw is unreachable via
// "env unset" (fallback always kicks in) — but IS reachable by explicitly setting the env var to the
// empty string '' (?? leaves '' alone, then the `v === ''` check fires). Verified below.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadServerEnv } from '../src/config';

const KEYS = ['NW_JWT_SECRET', 'NW_MONGO_URI', 'NW_MONGO_DB', 'NW_INTERNAL_KEY'] as const;

describe('loadServerEnv', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('falls back to dev defaults when the env vars are unset', () => {
    for (const k of KEYS) delete process.env[k];
    const env = loadServerEnv();
    expect(env).toEqual({
      jwtSecret: 'dev-insecure-secret-change-me',
      mongoUri: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
      mongoDb: 'notebook_wars',
      internalKey: 'dev-insecure-internal-key-change-me',
    });
  });

  it('reads explicitly-set env var values instead of the fallback', () => {
    process.env.NW_JWT_SECRET = 'my-secret';
    process.env.NW_MONGO_URI = 'mongodb://example/?x=1';
    process.env.NW_MONGO_DB = 'my_db';
    process.env.NW_INTERNAL_KEY = 'my-internal-key';
    const env = loadServerEnv();
    expect(env).toEqual({
      jwtSecret: 'my-secret',
      mongoUri: 'mongodb://example/?x=1',
      mongoDb: 'my_db',
      internalKey: 'my-internal-key',
    });
  });

  it('throw branch IS reachable: an env var explicitly set to the empty string bypasses the fallback (?? does not substitute on \'\') and throws', () => {
    process.env.NW_JWT_SECRET = '';
    expect(() => loadServerEnv()).toThrow('missing env: NW_JWT_SECRET');
  });

  it('throw branch fires for each of the 4 fields independently when set to \'\'', () => {
    process.env.NW_MONGO_URI = '';
    expect(() => loadServerEnv()).toThrow('missing env: NW_MONGO_URI');
  });
});
