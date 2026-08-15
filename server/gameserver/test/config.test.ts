// loadGameEnv() unit tests: pure env-var parsing, previously untested (0% coverage).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadGameEnv } from '../src/config';

const ENV_KEYS = [
  'NW_GAME_PORT',
  'NW_GAME_HOST',
  'NW_META_BASE_URL',
  'NW_GAME_PUBLIC_WS_URL',
  'NW_MATCHSVC_INTERNAL_URL',
  'NW_GAME_ID',
  'NW_GAME_CAPACITY',
] as const;

describe('loadGameEnv', () => {
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

  it('defaults: no env vars set -> documented fallbacks', () => {
    const env = loadGameEnv();
    expect(env.port).toBe(8081);
    expect(env.host).toBe('0.0.0.0');
    expect(env.metaBaseUrl).toBeNull();
    expect(env.publicWsUrl).toBeNull();
    expect(env.matchsvcInternalUrl).toBeNull();
    expect(env.capacity).toBe(100);
    expect(typeof env.gameId).toBe('string');
    expect(env.gameId.length).toBeGreaterThan(0);
  });

  it('every var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_GAME_PORT = '9999';
    process.env.NW_GAME_HOST = '127.0.0.1';
    process.env.NW_META_BASE_URL = 'http://meta:18080';
    process.env.NW_GAME_PUBLIC_WS_URL = 'ws://game.example.com/ws';
    process.env.NW_MATCHSVC_INTERNAL_URL = 'http://matchsvc:8091';
    process.env.NW_GAME_ID = 'game-fixed-1';
    process.env.NW_GAME_CAPACITY = '250';

    const env = loadGameEnv();
    expect(env.port).toBe(9999);
    expect(env.host).toBe('127.0.0.1');
    expect(env.metaBaseUrl).toBe('http://meta:18080');
    expect(env.publicWsUrl).toBe('ws://game.example.com/ws');
    expect(env.matchsvcInternalUrl).toBe('http://matchsvc:8091');
    expect(env.gameId).toBe('game-fixed-1');
    expect(env.capacity).toBe(250);
  });

  it('two calls without NW_GAME_ID set generate distinct random ids (not cached)', () => {
    const a = loadGameEnv();
    const b = loadGameEnv();
    expect(a.gameId).not.toBe(b.gameId);
  });
});
