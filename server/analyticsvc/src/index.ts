// analyticsvc 启动入口（A9-1）。
import { loadAnalyticssvcEnv } from './config';
import { createAnalyticsMongo } from './db';
import { AnalyticsService } from './service';
import { startHttpApi } from './httpApi';
import { startEtlScheduler } from './scheduler';
import { loadInternalAuth, createLogger, startHeartbeat } from '@nw/shared';

async function main(): Promise<void> {
  const env = loadAnalyticssvcEnv();
  const mongo = await createAnalyticsMongo(env.analyticsMongoUri, env.analyticsMongoDb);
  await mongo.ensureIndexes();

  const svc = new AnalyticsService(mongo.collections);
  const stopEtl = startEtlScheduler(svc);
  const server = startHttpApi(
    {
      host: env.host,
      port: env.port,
      jwtSecret: env.jwtSecret,
      internalAuth: loadInternalAuth(env.internalKey),
    },
    svc,
  );

  const shutdown = async (): Promise<void> => {
    stopEtl();
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[analyticsvc] started port=${env.port} db=${env.analyticsMongoDb}`);
  startHeartbeat(createLogger('analyticsvc')); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main().catch((e) => {
  console.error('[analyticsvc] failed to start:', e);
  process.exit(1);
});
