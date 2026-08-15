// loadMatchsvcEnv() unit tests: pure env-var parsing, previously untested (0% coverage).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadMatchsvcEnv } from '../src/config';

const ENV_KEYS = [
  'NW_MM_INTERNAL_PORT',
  'NW_MM_HOST',
  'NW_GATEWAY_INTERNAL_URL',
  'NW_GAME_PUBLIC_WS_URL',
  'NW_TICKET_TTL_SEC',
  'NW_ADMIN_INTERNAL_URL',
  'NW_REGION',
  'NW_MM_BOT_FALLBACK_MS',
  'NW_REDIS_URL',
] as const;

describe('loadMatchsvcEnv', () => {
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
    const env = loadMatchsvcEnv();
    expect(env.internalPort).toBe(8091);
    expect(env.host).toBe('0.0.0.0');
    expect(env.gatewayInternalUrl).toBeNull();
    expect(env.gamePublicWsUrl).toBeNull();
    expect(env.ticketTtlSec).toBe(30);
    expect(env.adminInternalUrl).toBeNull();
    expect(env.region).toBeNull();
    expect(env.botFallbackMs).toBe(30000);
    expect(env.redisUrl).toBeNull();
  });

  it('every var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_MM_INTERNAL_PORT = '9191';
    process.env.NW_MM_HOST = '127.0.0.1';
    process.env.NW_GATEWAY_INTERNAL_URL = 'http://gateway:8080';
    process.env.NW_GAME_PUBLIC_WS_URL = 'ws://game.example.com/ws';
    process.env.NW_TICKET_TTL_SEC = '45';
    process.env.NW_ADMIN_INTERNAL_URL = 'http://admin:18099';
    process.env.NW_REGION = 'eu-west';
    process.env.NW_MM_BOT_FALLBACK_MS = '15000';
    process.env.NW_REDIS_URL = 'redis://localhost:6379';

    const env = loadMatchsvcEnv();
    expect(env.internalPort).toBe(9191);
    expect(env.host).toBe('127.0.0.1');
    expect(env.gatewayInternalUrl).toBe('http://gateway:8080');
    expect(env.gamePublicWsUrl).toBe('ws://game.example.com/ws');
    expect(env.ticketTtlSec).toBe(45);
    expect(env.adminInternalUrl).toBe('http://admin:18099');
    expect(env.region).toBe('eu-west');
    expect(env.botFallbackMs).toBe(15000);
    expect(env.redisUrl).toBe('redis://localhost:6379');
  });
});
