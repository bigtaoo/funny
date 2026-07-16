// admin process bootstrap (OPS_DESIGN §0/§1): ops back-end, standalone process + dedicated DB, not reachable by players.
//   • Connects to dedicated DB notebook_wars_admin → indexes + seed super admin;
//   • AdminService (RBAC + ticket approval + audit + monitoring/trends);
//   • HTTP API for the ops front-end (admin JWT authentication);
//   • Self-sampling timer (pulls gateway/matchsvc /internal/stats and writes metricSnapshots).
// Reverse proxy does not route to admin; API port is only reachable from the internal network/VPN/IP allowlist (§6).
import { createLogger, loadInternalAuth, startHeartbeat, type JwtConfig } from '@nw/shared';
import { loadAdminEnv } from './config';
import { createAdminMongo } from './db';
import { AdminService } from './service';
import { startHttpApi } from './httpApi';
import { seedSuperAdmin } from './seed';
import { HttpAnalyticsClient, HttpAntiCheatClient, HttpAuctionClient, HttpEventsClient, HttpGachaPoolsClient, HttpLadderClient, HttpMailDispatcher, HttpMismatchClient, HttpPaddleEventsClient, HttpPlayerClient, HttpPromoClient, HttpStatsClient, HttpSuspiciousPveClient, HttpWorldClient } from './clients';

const log = createLogger('admin');

async function main(): Promise<void> {
  const env = loadAdminEnv();

  const mongo = await createAdminMongo(env.adminMongoUri, env.adminMongoDb);
  await mongo.ensureIndexes(env.snapshotTtlSec);
  await seedSuperAdmin(mongo.collections, env.seedUser, env.seedPass, () => Date.now());

  const stats = new HttpStatsClient(env.gatewayInternalUrl, env.matchsvcInternalUrl, env.internalKey);
  const players = new HttpPlayerClient(env.metaBaseUrl, env.internalKey);
  const antiCheat = new HttpAntiCheatClient(env.metaBaseUrl, env.internalKey);
  const mismatches = new HttpMismatchClient(env.metaBaseUrl, env.internalKey);
  const suspiciousPve = new HttpSuspiciousPveClient(env.metaBaseUrl, env.internalKey);
  const mail = new HttpMailDispatcher(env.metaBaseUrl, env.internalKey);
  const analytics = new HttpAnalyticsClient(env.analyticsBaseUrl, env.internalKey);
  const world = new HttpWorldClient(env.worldInternalUrl, env.internalKey);
  const auction = new HttpAuctionClient(env.auctionInternalUrl, env.internalKey);
  const ladder = new HttpLadderClient(env.metaBaseUrl, env.internalKey);
  const events = new HttpEventsClient(env.metaBaseUrl, env.internalKey);
  const gachaPools = new HttpGachaPoolsClient(env.metaBaseUrl, env.internalKey);
  const promo = new HttpPromoClient(env.metaBaseUrl, env.internalKey);
  const paddleEvents = new HttpPaddleEventsClient(env.metaBaseUrl, env.internalKey);

  const svc = new AdminService({ cols: mongo.collections, stats, players, antiCheat, mismatches, suspiciousPve, mail, analytics, world, auction, ladder, events, gachaPools, promo, paddleEvents, now: () => Date.now() });

  const jwt: JwtConfig = { secret: env.adminJwtSecret, expiresIn: env.adminJwtTtl };
  const server = startHttpApi(
    { host: env.host, port: env.port, jwt, internalAuth: loadInternalAuth(env.internalKey) },
    svc,
  );

  // Self-sampling timer (§5). Continues running even when stats are unavailable (writes zero values so the trend stays continuous).
  let sampler: NodeJS.Timeout | null = null;
  if (env.sampleIntervalMs > 0) {
    sampler = setInterval(() => {
      void svc.sampleOnce().catch((e) => log.error('sample failed', { err: (e as Error).message }));
    }, env.sampleIntervalMs);
    sampler.unref?.();
  }

  const shutdown = async (): Promise<void> => {
    if (sampler) clearInterval(sampler);
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('admin API listening', { port: env.port, db: env.adminMongoDb });
  console.log(`admin HTTP API on :${env.port} (ops front-end only); db=${env.adminMongoDb}`);
  console.log(
    `stats: gateway=${env.gatewayInternalUrl ?? 'none'} matchsvc=${env.matchsvcInternalUrl ?? 'none'}; ` +
      `meta(player/mail)=${env.metaBaseUrl ?? 'none'}; sample=${env.sampleIntervalMs}ms`,
  );
  startHeartbeat(log); // Liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  console.error('admin failed to start:', e);
  process.exit(1);
});
