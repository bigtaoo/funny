// metaserver process bootstrap: connect Mongo → buildApp → listen.
// Reverse proxy forwards /api/* to this process (SERVER_API.md §0).
import { createMongo, createLogger, startHeartbeat, FeatureFlagCache, internalHeaders, connectActiveMatchRedis, type JwtConfig } from '@nw/shared';
import { loadMetaEnv } from './config.js';
import { buildApp, SPEC_PATH } from './app.js';
import { HttpGatewayClient } from './gatewayClient.js';
import { auditOnce } from './anticheatAudit.js';

const log = createLogger('meta');

/**
 * Process-level error alerting (S4-3).
 * NW_ALERT_WEBHOOK_URL: when set to a Slack/Discord/WeCom webhook URL,
 * uncaughtException/unhandledRejection will additionally POST an alert message
 * (fire-and-forget, does not affect the main flow).
 */
function setupAlerts(): void {
  const webhook = process.env.NW_ALERT_WEBHOOK_URL;
  const sendAlert = webhook
    ? (text: string) => {
        void fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[NW metaserver] ${text}` }),
        }).catch(() => {/* ignore webhook delivery failures */});
      }
    : null;

  process.on('uncaughtException', (e: Error) => {
    log.error('uncaughtException', { err: e.stack ?? String(e) });
    sendAlert?.(`uncaughtException: ${e.message}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    log.error('unhandledRejection', { reason: msg });
    sendAlert?.(`unhandledRejection: ${msg}`);
  });
}

setupAlerts();

async function main() {
  const env = loadMetaEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const mongo = await createMongo(env.mongoUri, env.mongoDb);
  await mongo.ensureIndexes();

  // Feature flag cache (used by the public /bootstrap evaluation, FEATURE_FLAGS_DESIGN §9.3):
  // polls admin for raw rules and evaluates locally.
  // ⚠ NW_ADMIN_INTERNAL_URL (pointing to http://admin:8083) must be set; otherwise polling
  //   does not start → all flags remain at their defaults → bootstrap always returns an empty map
  //   → client-side targeted log collection never activates (a known deployment gotcha, same as matchsvc).
  const adminUrl = env.adminInternalUrl;
  const flags = new FeatureFlagCache({
    fetchAll: async () => {
      if (!adminUrl) return [];
      const res = await fetch(`${adminUrl}/admin/internal/flags`, {
        headers: internalHeaders('meta', env.internalKey),
      });
      if (!res.ok) throw new Error(`admin flags ${res.status}`);
      const body = (await res.json()) as { flags?: unknown[] };
      return Array.isArray(body.flags) ? body.flags : [];
    },
    ...(env.region ? { region: env.region } : {}),
    onError: (e) => log.warn('flag refresh failed (keeping cache)', { err: (e as Error).message }),
  });
  if (adminUrl) await flags.start();

  const redis = await connectActiveMatchRedis(env.redisUrl);

  const app = await buildApp({
    cols: mongo.collections,
    jwt,
    internalKey: env.internalKey,
    commercialUrl: env.commercialUrl,
    gatewayUrl: env.gatewayInternalUrl,
    gatewayPublicUrl: env.gatewayPublicUrl,
    authRateLimit: env.authRateLimit,
    flags,
    region: env.region,
    lokiPushUrl: env.lokiPushUrl,
    socialsvcUrl: env.socialsvcInternalUrl,
    redis,
    // Request logging goes through the readable onResponse hook inside buildApp (@nw/shared logger); not using pino JSON.
    logger: false,
  });

  // Achievement anti-cheat offline sampling batch (S9-7, ACHIEVEMENT_DESIGN §4.4): periodically
  // samples ranked matches, re-calculates them via peer judge, and compares results.
  // Kept outside the request path (alongside buildApp); e2e tests call auditOnce directly.
  // If gateway is not configured → available=false and the entire batch is skipped.
  const auditGateway = new HttpGatewayClient(env.gatewayInternalUrl, env.internalKey);
  const auditTimer =
    env.auditIntervalMs > 0
      ? setInterval(() => {
          void auditOnce({
            cols: mongo.collections,
            gateway: auditGateway,
            now: () => Date.now(),
            sampleLimit: env.auditSampleLimit,
          })
            .then((r) => {
              if (r.flagged > 0 || r.audited > 0) log.info('anti-cheat audit tick', { ...r });
            })
            .catch((e) => log.error('anti-cheat audit tick failed', { err: (e as Error).message }));
        }, env.auditIntervalMs)
      : null;
  auditTimer?.unref?.();

  const shutdown = async () => {
    if (auditTimer) clearInterval(auditTimer);
    await app.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
  log.info(`metaserver up on ${env.host}:${env.port}`, {
    spec: SPEC_PATH,
    commercial: env.commercialUrl ?? 'disabled',
    gateway: env.gatewayInternalUrl ?? 'disabled',
    gatewayPublic: env.gatewayPublicUrl ?? 'none',
    activeMatchRedis: redis ? 'connected' : 'disabled',
  });
  startHeartbeat(log); // Liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  log.error('metaserver failed to start', { err: (e as Error).stack ?? String(e) });
  process.exit(1);
});
