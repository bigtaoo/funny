// loadBotsvcEnv() unit tests: pure env-var parsing, previously untested (0% coverage). Same pattern as
// gateway/admin/gameserver's config.test.ts — botsvc owns no database and verifies no player JWTs, so
// unlike those it has no base ServerEnv dependency to satisfy first.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadBotsvcEnv } from '../src/config';

const ENV_KEYS = [
  'NW_BOT_PORT', 'NW_BOT_HOST', 'NW_BOT_POOL_SIZE', 'NW_BOT_TARGET_ONLINE', 'NW_BOT_CAPACITY_CAP',
  'NW_BOT_SHED_START_AT', 'NW_BOT_SHED_FULL_AT', 'NW_META_BASE_URL', 'NW_SOCIAL_BASE_URL',
  'NW_WORLD_BASE_URL', 'NW_GATEWAY_INTERNAL_URL', 'NW_GATEWAY_WS_URL', 'NW_COMMERCIAL_INTERNAL_URL',
  'NW_INTERNAL_KEY', 'NW_BOT_BATTLE_CHANCE', 'NW_BOT_UPKEEP_CONCURRENCY', 'NW_BOT_TICK_MS',
  'NW_BOT_UPKEEP_ROTATIONS', 'NW_BOT_DEVICE_OFFSET', 'NW_BOT_SPAWN_BATCH',
] as const;

describe('loadBotsvcEnv', () => {
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
    const env = loadBotsvcEnv();
    expect(env.port).toBe(18087);
    expect(env.host).toBe('127.0.0.1');
    expect(env.poolSize).toBe(1000);
    expect(env.targetOnline).toBe(100);
    expect(env.capacityCap).toBe(3000);
    expect(env.shedStartAt).toBe(2500);
    expect(env.shedFullAt).toBe(2800);
    expect(env.metaBaseUrl).toBe('http://127.0.0.1:18080');
    expect(env.socialBaseUrl).toBe('http://127.0.0.1:8085');
    expect(env.worldBaseUrl).toBe('http://127.0.0.1:18084');
    expect(env.gatewayInternalUrl).toBe('http://127.0.0.1:8090');
    expect(env.gatewayWsUrl).toBe('ws://127.0.0.1:8086/gw');
    expect(env.commercialInternalUrl).toBe('http://127.0.0.1:18082');
    expect(env.internalKey).toBe('dev-insecure-internal-key-change-me');
    expect(env.battleChancePerTick).toBe(0.025);
    expect(env.upkeepConcurrency).toBe(20);
    expect(env.tickMs).toBe(5000);
    expect(env.upkeepRotations).toBe(3);
    expect(env.deviceOffset).toBe(0);
    expect(env.spawnBatch).toBe(10);
  });

  it('every var set -> all threaded through verbatim (except numeric coercion)', () => {
    process.env.NW_BOT_PORT = '19999';
    process.env.NW_BOT_HOST = '0.0.0.0';
    process.env.NW_BOT_POOL_SIZE = '5000';
    process.env.NW_BOT_TARGET_ONLINE = '500';
    process.env.NW_BOT_CAPACITY_CAP = '4000';
    process.env.NW_BOT_SHED_START_AT = '3500';
    process.env.NW_BOT_SHED_FULL_AT = '3800';
    process.env.NW_META_BASE_URL = 'http://meta:18080';
    process.env.NW_SOCIAL_BASE_URL = 'http://social:8085';
    process.env.NW_WORLD_BASE_URL = 'http://world:18084';
    process.env.NW_GATEWAY_INTERNAL_URL = 'http://gateway:8090';
    process.env.NW_GATEWAY_WS_URL = 'ws://gateway:8086/gw';
    process.env.NW_COMMERCIAL_INTERNAL_URL = 'http://commercial:18082';
    process.env.NW_INTERNAL_KEY = 'prod-internal-key';
    process.env.NW_BOT_BATTLE_CHANCE = '0.5';
    process.env.NW_BOT_UPKEEP_CONCURRENCY = '50';
    process.env.NW_BOT_TICK_MS = '1000';
    process.env.NW_BOT_UPKEEP_ROTATIONS = '5';
    process.env.NW_BOT_DEVICE_OFFSET = '1000';
    process.env.NW_BOT_SPAWN_BATCH = '25';

    const env = loadBotsvcEnv();
    expect(env.port).toBe(19999);
    expect(env.host).toBe('0.0.0.0');
    expect(env.poolSize).toBe(5000);
    expect(env.targetOnline).toBe(500);
    expect(env.capacityCap).toBe(4000);
    expect(env.shedStartAt).toBe(3500);
    expect(env.shedFullAt).toBe(3800);
    expect(env.metaBaseUrl).toBe('http://meta:18080');
    expect(env.socialBaseUrl).toBe('http://social:8085');
    expect(env.worldBaseUrl).toBe('http://world:18084');
    expect(env.gatewayInternalUrl).toBe('http://gateway:8090');
    expect(env.gatewayWsUrl).toBe('ws://gateway:8086/gw');
    expect(env.commercialInternalUrl).toBe('http://commercial:18082');
    expect(env.internalKey).toBe('prod-internal-key');
    expect(env.battleChancePerTick).toBe(0.5);
    expect(env.upkeepConcurrency).toBe(50);
    expect(env.tickMs).toBe(1000);
    expect(env.upkeepRotations).toBe(5);
    expect(env.deviceOffset).toBe(1000);
    expect(env.spawnBatch).toBe(25);
  });
});
