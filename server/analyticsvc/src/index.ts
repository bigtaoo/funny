// analyticsvc 启动入口（A9-1）。
import { loadAnalyticssvcEnv } from './config';
import { createAnalyticsMongo } from './db';
import { AnalyticsService } from './service';
import { startHttpApi } from './httpApi';

async function main(): Promise<void> {
  const env = loadAnalyticssvcEnv();
  const mongo = await createAnalyticsMongo(env.analyticsMongoUri, env.analyticsMongoDb);
  await mongo.ensureIndexes();

  const svc = new AnalyticsService(mongo.collections);
  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    svc,
  );

  const shutdown = async (): Promise<void> => {
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[analyticsvc] started port=${env.port} db=${env.analyticsMongoDb}`);
}

main().catch((e) => {
  console.error('[analyticsvc] failed to start:', e);
  process.exit(1);
});
