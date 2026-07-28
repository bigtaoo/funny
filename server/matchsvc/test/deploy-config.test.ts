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

describe('deploy config — worldsvc internal-URL wiring (comm-audit-internal-2026-07-28 P0-6)', () => {
  // prod was missing NW_META_INTERNAL_URL (season mails/titles silently no-op'd, stronghold loot
  // vanished, setTeams threw INTERNAL); NW_ADMIN_INTERNAL_URL was missing EVERYWHERE (the SLG
  // shop-price cache never started, so the ops price panel was permanently inert with no log).
  // Same failure family as the 2026-07-04 world-chat fee gap — lint every internal URL worldsvc
  // consumes so the next new environment can't silently drop one.
  const REQUIRED: Record<string, string> = {
    NW_GATEWAY_INTERNAL_URL: 'gateway',
    NW_SOCIALSVC_INTERNAL_URL: 'socialsvc',
    NW_COMMERCIAL_INTERNAL_URL: 'commercial',
    NW_META_INTERNAL_URL: 'metaserver',
    NW_ADMIN_INTERNAL_URL: 'admin',
  };
  for (const file of COMPOSE_FILES) {
    for (const [key, host] of Object.entries(REQUIRED)) {
      it(`${file}: worldsvc injects ${key}`, () => {
        const env = loadServiceEnv(file, 'worldsvc');
        expect(env[key], `worldsvc missing ${key}`).toBeTruthy();
        expect(env[key]).toContain(host);
      });
    }
  }
});

describe('deploy config — admin ops-proxy wiring (comm-audit-internal-2026-07-28 P0-6)', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: admin injects NW_WORLD_INTERNAL_URL + NW_AUCTION_INTERNAL_URL (otherwise the whole SLG ops surface throws 'not configured')`, () => {
      const env = loadServiceEnv(file, 'admin');
      expect(env.NW_WORLD_INTERNAL_URL, 'admin missing NW_WORLD_INTERNAL_URL').toBeTruthy();
      expect(env.NW_AUCTION_INTERNAL_URL, 'admin missing NW_AUCTION_INTERNAL_URL').toBeTruthy();
    });
  }
});

describe('deploy config — metaserver feature-flag wiring (comm-audit-internal-2026-07-28)', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: metaserver injects NW_ADMIN_INTERNAL_URL (otherwise flag polling never starts)`, () => {
      const env = loadServiceEnv(file, 'metaserver');
      expect(env.NW_ADMIN_INTERNAL_URL, 'metaserver missing NW_ADMIN_INTERNAL_URL → flags always defaulted').toBeTruthy();
    });
  }
});

describe('deploy config — pm2 ecosystem parity (comm-audit-internal-2026-07-28 P0-6)', () => {
  // The pm2 path had drifted far behind compose: NO app block had NW_ADMIN_INTERNAL_URL (flag +
  // shop-price polling dead), nw-world lacked meta/commercial URLs (season rewards lost, every
  // coin sink hard-failing), nw-admin lacked world/auction/analytics URLs (SLG ops dead). compose
  // gets fixed when incidents happen; ecosystem.config.cjs was consistently forgotten — lint it
  // against the same expectations.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const ecosystem = require(join(__dirname, '..', '..', 'ecosystem.config.cjs')) as {
    apps: { name: string; env: Record<string, string | undefined> }[];
  };
  const appEnv = (name: string): Record<string, string | undefined> => {
    const app = ecosystem.apps.find((a) => a.name === name);
    if (!app) throw new Error(`ecosystem.config.cjs: app ${name} missing`);
    return app.env;
  };
  const CASES: [app: string, key: string][] = [
    ['nw-meta', 'NW_ADMIN_INTERNAL_URL'],
    ['nw-matchsvc', 'NW_ADMIN_INTERNAL_URL'],
    ['nw-world', 'NW_META_INTERNAL_URL'],
    ['nw-world', 'NW_COMMERCIAL_INTERNAL_URL'],
    ['nw-world', 'NW_ADMIN_INTERNAL_URL'],
    ['nw-world', 'NW_GATEWAY_INTERNAL_URL'],
    ['nw-world', 'NW_SOCIALSVC_INTERNAL_URL'],
    ['nw-admin', 'NW_WORLD_INTERNAL_URL'],
    ['nw-admin', 'NW_AUCTION_INTERNAL_URL'],
    ['nw-admin', 'NW_ANALYTICS_BASE_URL'],
  ];
  for (const [app, key] of CASES) {
    it(`ecosystem.config.cjs: ${app} injects ${key}`, () => {
      expect(appEnv(app)[key], `${app} missing ${key}`).toBeTruthy();
    });
  }
});

describe('deploy config — local compose worldsvc socialsvc wiring (comm-audit-internal-2026-07-28)', () => {
  // local was the odd one out here: prod/cloud had NW_SOCIALSVC_INTERNAL_URL, local didn't →
  // every sect operation in the local full stack failed with NOT_IN_FAMILY.
  it('docker-compose.local.yml: worldsvc injects NW_SOCIALSVC_INTERNAL_URL', () => {
    const text = readFileSync(join(__dirname, '..', '..', '..', 'docker', 'docker-compose.local.yml'), 'utf8');
    const doc = yaml.load(text) as ComposeDoc;
    const env = doc.services?.worldsvc?.environment;
    expect(env?.NW_SOCIALSVC_INTERNAL_URL, 'local worldsvc missing NW_SOCIALSVC_INTERNAL_URL → sect ops NOT_IN_FAMILY').toBeTruthy();
  });
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
