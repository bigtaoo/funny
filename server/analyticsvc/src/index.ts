// analyticsvc startup entry point (A9-1).
import { loadAnalyticssvcEnv } from './config';
import { createAnalyticsMongo } from './db';
import { AnalyticsService } from './service';
import { startHttpApi } from './httpApi';
import { startEtlScheduler } from './scheduler';
import { loadInternalAuth, createLogger, startHeartbeat, startTokenRevocationList } from '@nw/shared';

async function main(): Promise<void> {
  const env = loadAnalyticssvcEnv();
  const mongo = await createAnalyticsMongo(env.analyticsMongoUri, env.analyticsMongoDb);
  await mongo.ensureIndexes();

  const svc = new AnalyticsService(mongo.collections);
  const stopEtl = startEtlScheduler(svc);
  // C5-b: a purged account's leaked token must not re-attach its user_id to new events.
  const tokenRevocations = startTokenRevocationList(env.metaInternalUrl, {
    caller: 'analyticsvc',
    key: env.internalKey,
    log: createLogger('analyticsvc:token-revocations'),
  });
  const server = startHttpApi(
    {
      host: env.host,
      port: env.port,
      jwtSecret: env.jwtSecret,
      internalAuth: loadInternalAuth(env.internalKey),
      tokenRevocations,
    },
    svc,
  );

  const shutdown = async (): Promise<void> => {
    stopEtl();
    tokenRevocations?.stop();
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[analyticsvc] started port=${env.port} db=${env.analyticsMongoDb}`);
  startHeartbeat(createLogger('analyticsvc')); // liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  console.error('[analyticsvc] failed to start:', e);
  process.exit(1);
});
