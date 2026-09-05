// Deployment config lint: matchsvc must have NW_ADMIN_INTERNAL_URL injected in the production compose, otherwise
// feature flag polling never starts → switches like match_bot_fallback stay at their default false → back-end changes have no effect.
// This was the root cause of the 2026-06-24 production incident (missing compose entry; pure logic unit tests cannot catch it — only lint of the deploy file can).
// Only validates real deployment targets cloud / prod; ci is an integration-test override (does not start admin) and is excluded.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

/** Every `process.env.NW_*` name read anywhere under a service's src/. */
function envReads(srcDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.(NW_[A-Z0-9_]+)/g)) found.add(m[1]!);
      }
    }
  };
  walk(srcDir);
  return [...found].sort();
}

function loadEcosystemEnv(app: string): Record<string, string | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const ecosystem = require(join(__dirname, '..', '..', 'ecosystem.config.cjs')) as {
    apps: { name: string; env: Record<string, string | undefined> }[];
  };
  const env = ecosystem.apps.find((a) => a.name === app)?.env;
  if (!env) throw new Error(`ecosystem.config.cjs: app ${app} missing`);
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

describe('deploy config — commercial payment credentials (2026-09-04 / 2026-09-05)', () => {
  // The longest-lived instance of this file's whole failure family: `NW_APPLE_PASSWORD` sat in the VPS
  // .env from the day that file was written and never reached the process, because compose interpolates
  // only the `${...}` written in the compose file itself — so Apple receipt verification was fail-closed
  // in production the entire time, with no log and no error. cloud was fixed on 2026-09-04 by hand;
  // prod and the pm2 path still carried the identical gap a day later, which is exactly the drift the
  // rest of this file exists to stop.
  //
  // So don't enumerate the credentials: derive them. Every NW_* the commercial process reads must appear
  // in its environment block, and a new payment credential is then covered the day it is first read.
  // The scan, the exclusion table and the pm2 inventory check now live in the all-service block below —
  // commercial was simply the first service to get them. What stays here is commercial-only: the two
  // interpolation traps that cost real money when they fire.
  for (const file of COMPOSE_FILES) {
    it(`${file}: every defaulted commercial var uses the \${X:-default} form, not \${X-default}`, () => {
      // `-` only substitutes when the var is UNSET; `:-` also substitutes when it is set-but-empty. The
      // code reads `process.env.X ?? default`, and an empty string is not nullish — so with the `-` form
      // an empty .env line beats the default. For NW_IAP_BUNDLE that means every App Store product id
      // resolves to 0 coins while verification still reports success: the player pays and gets nothing.
      const env = loadServiceEnv(file, 'commercial');
      const wrong = Object.entries(env).filter(([, v]) => /^\$\{[A-Z0-9_]+-/.test(String(v)));
      expect(wrong.map(([k]) => k)).toEqual([]);
    });

    it(`${file}: NW_IAP_BUNDLE defaults to the shipped bundle id, not the code's placeholder`, () => {
      // The code default is `com.nw` (a placeholder that fails closed AND silently). The deployed default
      // has to be the real shipped Bundle ID, or a stack brought up without that .env line resolves nothing.
      expect(loadServiceEnv(file, 'commercial').NW_IAP_BUNDLE).toBe('${NW_IAP_BUNDLE:-com.gamestao.nivara}');
    });
  }
});

describe('deploy config — every service passes through what its source reads (2026-09-05)', () => {
  // Generalization of the commercial block above. Running that block's scan across the other nine
  // services turned up 25 read-but-never-passed vars, so the shape earns being applied everywhere:
  // derive the expectation from `src/`, and a var is covered the day it is first read rather than the
  // day someone remembers to add it here.
  //
  // Most of the 25 were tuning knobs whose code defaults ARE the production values — those belong in
  // NOT_DEPLOYED with a reason, not in compose. The point of the table is that each one was decided;
  // an entry is a claim that the omission is correct, and it has to say why. Six were real:
  //   - metaserver NW_SOCIALSVC_INTERNAL_URL: prod + pm2 only. socialsvc is the sole friend/chat/mail
  //     authority since P2, so meta fell back to nullMetaSocialsvcClient: every /social/* route 503,
  //     system mail throwing. The worst of the set, and the one the original triage list had missed.
  //   - socialsvc NW_ADMIN_INTERNAL_URL: moderation word-list overlay never polls; ops edits inert.
  //   - admin NW_ANALYTICS_BASE_URL: analyticsvc runs in the same stack, admin was never told where;
  //     every analytics panel renders empty because query() returns {} rather than erroring.
  //   - metaserver NW_WECHAT_ADS_KEY: /ads/callback/wechat answers 503 while unset, so WeChat's
  //     server-side reward callback was dead, not merely unverified.
  //   - metaserver NW_ADMOB_CLIENT_KEY / NW_WECHAT_ADS_CLIENT_KEY: fail open, so the gap meant client
  //     ad-token verification could never be switched on however the operator filled in .env.
  //   - metaserver NW_ALERT_WEBHOOK_URL: crash alerts silently went nowhere.
  // The last four share the NW_APPLE_PASSWORD shape exactly: a line in .env.example that the operator
  // dutifully fills in and that no deployment path ever forwards.

  /** compose service -> pm2 app name. null = compose-only (botsvc has no pm2 app). */
  const PM2_APP: Record<string, string | null> = {
    metaserver: 'nw-meta',
    commercial: 'nw-commercial',
    gateway: 'nw-gateway',
    matchsvc: 'nw-matchsvc',
    gameserver: 'nw-game',
    worldsvc: 'nw-world',
    admin: 'nw-admin',
    socialsvc: 'nw-social',
    auctionsvc: 'nw-auction',
    analyticsvc: 'nw-analytics',
    botsvc: null,
  };

  // Deliberate omissions, with the reason that makes each one a decision rather than the next incident.
  // Removing an entry should be the first thing you try when a feature "does nothing in production".
  const NOT_DEPLOYED: Record<string, Record<string, string>> = {
    metaserver: {
      NW_OAUTH_GOOGLE_CLIENT_ID:
        'client-side OAuth is not implemented — ACCOUNT_DESIGN.md SA-2 parks it until there is a callback domain to test against, and LoginScene has no oauthWait view. Nothing reaches /auth/oauth, so credentials here would be decoration. Wire both the day that view ships.',
      NW_OAUTH_GOOGLE_CLIENT_SECRET: 'see NW_OAUTH_GOOGLE_CLIENT_ID',
      NW_GATEWAY_PUBLIC_WS_URL:
        'Caddy serves /api and /gw from one origin, so the client derivation in net/config.ts (http->ws, /api->/gw) already produces the right address; sending it explicitly would only add a second place to get it wrong. The var exists for split-origin stacks like CI (meta :18080, gateway :8086/gw).',
      NW_ACHIEVEMENT_AUDIT_INTERVAL_MS: 'tuning knob; code default 60s is the production value',
      NW_ACHIEVEMENT_AUDIT_SAMPLE_LIMIT: 'tuning knob; code default 5 is the production value',
      NW_AUTH_RATE_LIMIT: 'tuning knob; code default 20 per 15min sliding window is the production value',
    },
    admin: {
      NW_ADMIN_JWT_TTL: "tuning knob; code default '8h' is the production value",
      NW_ADMIN_SAMPLE_MS: 'tuning knob; code default 30s is the production value',
      NW_ADMIN_SNAPSHOT_TTL_SEC: 'tuning knob; code default 14d matches the metricSnapshots retention window',
    },
    gateway: {
      NW_GW_RATE_LIMIT_TIGHT: 'tuning knob; code default 10 is the production value',
      NW_GW_RATE_LIMIT_STANDARD: 'tuning knob; code default 20 is the production value',
    },
    matchsvc: {
      NW_TICKET_TTL_SEC: 'tuning knob; code default 30s is the production value',
    },
    gameserver: {
      NW_GAME_ID:
        'must NOT be pinned. The randomUUID() default is what makes a restarted instance register as a new id, and matchsvc GameRegistry drops the old one after STALE_MS=30s; a fixed id would make two instances collide on one registry entry.',
      NW_GAME_CAPACITY: 'tuning knob; code default 100 is the production value',
    },
    worldsvc: {
      NW_COMPUTE_BACKEND:
        'selects the standalone compute service, which is not built yet (compute/index.ts); anything other than "remote", including unset, gives the in-process worker pool that cloud/prod actually run',
      NW_COMPUTE_URL: 'only read on the NW_COMPUTE_BACKEND=remote branch — see above',
      NW_COMPUTE_POOL_SIZE:
        'self-sizing default, cpus-1 (compute/pool.ts). Caveat worth remembering: os.cpus() reports the HOST cpu count from inside a container and no service here sets a cpu limit, so if a siege ever starves the box this is the first knob to promote to a real compose line.',
      NW_COMPUTE_TASK_TIMEOUT_MS: 'tuning knob; code default 30s before a hung worker is replaced',
      NW_SLG_AUTO_SETTLE:
        "reads `!== '0'`, i.e. season auto-settle is ON unless explicitly disabled — which is what cloud/prod want; the var exists to turn it off for a manual settlement",
      NW_SLG_ARRIVAL_SCAN_LIMIT: 'tuning knob; code default 500 per scan is the production value',
    },
    botsvc: {
      NW_BOT_BATTLE_CHANCE: 'tuning knob; code default 0.025 per tick is the production value',
    },
    commercial: {
      // The dev receipt stub. index.ts refuses to start with it set under NODE_ENV=production (which the
      // Dockerfile hard-codes), so passing it through could only ever break the container.
      NW_IAP_DEV: 'dev stub, refused under NODE_ENV=production',
    },
  };

  for (const [service, pm2App] of Object.entries(PM2_APP)) {
    const excluded = NOT_DEPLOYED[service] ?? {};
    const all = envReads(join(__dirname, '..', '..', service, 'src'));
    const reads = all.filter((k) => !(k in excluded));

    it(`${service}: the scan found source to read at all (an empty set makes every case below vacuous)`, () => {
      expect(all.length).toBeGreaterThan(0);
    });

    it(`${service}: every NOT_DEPLOYED entry is still read by the source (no stale exclusions)`, () => {
      // An exclusion for a var nobody reads any more is dead weight that makes the table less trustworthy
      // — and worse, would go on excusing the name if it ever came back for a different purpose.
      expect(Object.keys(excluded).filter((k) => !all.includes(k))).toEqual([]);
    });

    for (const file of COMPOSE_FILES) {
      it(`${file}: ${service} passes through every NW_* its source reads`, () => {
        const env = loadServiceEnv(file, service);
        expect(
          reads.filter((k) => !(k in env)),
          `${service} reads these but ${file} never passes them -> the process sees the code default, whatever .env says. Add the line, or add a NOT_DEPLOYED entry saying why the default is right.`,
        ).toEqual([]);
      });
    }

    if (pm2App) {
      it(`ecosystem.config.cjs: ${pm2App} lists the same set`, () => {
        // pm2 inherits the ambient environment, so a missing line here is not fatal the way a missing
        // compose line is — but this file is the inventory of what the process needs, and it is the one
        // that has historically been forgotten (see the parity block above). Presence, not truthiness:
        // credentials are intentionally `process.env.X` with no default, i.e. undefined unless provided.
        const env = loadEcosystemEnv(pm2App);
        expect(reads.filter((k) => !(k in env))).toEqual([]);
      });
    }
  }
});
