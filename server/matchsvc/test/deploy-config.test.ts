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

function loadMatchsvcEnv(file: string): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', '..', file), 'utf8');
  const doc = yaml.load(text) as ComposeDoc;
  const env = doc.services?.matchsvc?.environment;
  if (!env) throw new Error(`${file}: matchsvc.environment missing`);
  return env;
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
