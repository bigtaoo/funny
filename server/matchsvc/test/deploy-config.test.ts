// Deployment config lint: matchsvc must have NW_ADMIN_INTERNAL_URL injected in the production compose, otherwise
// feature flag polling never starts → switches like match_bot_fallback stay at their default false → back-end changes have no effect.
// This was the root cause of the 2026-06-24 production incident (missing compose entry; pure logic unit tests cannot catch it — only lint of the deploy file can).
// Only validates real deployment targets cloud / prod; ci is an integration-test override (does not start admin) and is excluded.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const COMPOSE_FILES = ['docker-compose.cloud.yml', 'docker-compose.prod.yml'];

type ComposeDoc = { services?: Record<string, { environment?: Record<string, string> }> };

function loadServiceEnv(file: string, service: string): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', '..', file), 'utf8');
  const doc = yaml.load(text) as ComposeDoc;
  const env = doc.services?.[service]?.environment;
  if (!env) throw new Error(`${file}: ${service}.environment missing`);
  return env;
}

function loadMatchsvcEnv(file: string): Record<string, string> {
  return loadServiceEnv(file, 'matchsvc');
}

describe('deploy config — matchsvc feature flag wiring', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: matchsvc injects NW_ADMIN_INTERNAL_URL pointing to admin (otherwise flags never take effect)`, () => {
      const env = loadMatchsvcEnv(file);
      expect(env.NW_ADMIN_INTERNAL_URL, 'matchsvc missing NW_ADMIN_INTERNAL_URL → flag polling disabled').toBeTruthy();
      expect(env.NW_ADMIN_INTERNAL_URL).toContain('admin');
    });
  }
});

describe('deploy config — matchsvc redis wiring (2026-07-18)', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: matchsvc injects NW_REDIS_URL pointing to redis (otherwise active-match resume never persists, and gateway push falls back to a single fixed address — breaks once gateway has >1 replica)`, () => {
      const env = loadMatchsvcEnv(file);
      expect(env.NW_REDIS_URL, 'matchsvc missing NW_REDIS_URL → resume-prompt data + multi-instance gateway push both disabled').toBeTruthy();
      expect(env.NW_REDIS_URL).toContain('redis');
    });
  }
});

describe('deploy config — metaserver redis wiring (2026-07-27)', () => {
  // matchsvc writes nw:activeMatch:{accountId} on match start; metaserver is the only reader/clearer
  // (GET /save surfaces it, /internal/match/report clears it). Without NW_REDIS_URL here, metaserver
  // silently never connects — matchsvc keeps writing the key but the resume prompt never reaches the
  // client, and the key just sits until its 1h TTL. Found 2026-07-27 during a full Mongo/Redis audit:
  // metaserver had never had this variable in any deployment file.
  for (const file of COMPOSE_FILES) {
    it(`${file}: metaserver injects NW_REDIS_URL pointing to redis (otherwise the login-reconnect resume prompt is silently dead)`, () => {
      const env = loadServiceEnv(file, 'metaserver');
      expect(env.NW_REDIS_URL, 'metaserver missing NW_REDIS_URL → resume-prompt read/clear path disabled').toBeTruthy();
      expect(env.NW_REDIS_URL).toContain('redis');
    });
  }
});

describe('deploy config — commercial redis wiring (2026-07-27)', () => {
  // victoryDaily (the tiered ranked-win coin cap) moved off Mongo to Redis (mid-term item 3/5 of the
  // 2026-07-27 audit, shared/src/dailyCounter.ts). Missing NW_REDIS_URL here doesn't break anything
  // (the cap falls back to a correct-for-single-instance in-process counter — see that module's doc
  // comment) but silently forfeits the point of the migration: the counter resets on every commercial
  // restart/redeploy instead of surviving it, and Atlas round trips come back for this one write path.
  for (const file of COMPOSE_FILES) {
    it(`${file}: commercial injects NW_REDIS_URL pointing to redis (otherwise victoryDaily silently falls back to a per-process counter that resets on every redeploy)`, () => {
      const env = loadServiceEnv(file, 'commercial');
      expect(env.NW_REDIS_URL, 'commercial missing NW_REDIS_URL → victoryDaily loses cross-restart persistence').toBeTruthy();
      expect(env.NW_REDIS_URL).toContain('redis');
    });
  }
});
