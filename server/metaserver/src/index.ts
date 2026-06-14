// metaserver 进程引导：连 Mongo → buildApp → listen。
// 反代将 /api/* 转到本进程（SERVER_API.md §0）。
import { createMongo, createLogger, type JwtConfig } from '@nw/shared';
import { loadMetaEnv } from './config.js';
import { buildApp, SPEC_PATH } from './app.js';

const log = createLogger('meta');

async function main() {
  const env = loadMetaEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const mongo = await createMongo(env.mongoUri, env.mongoDb);
  await mongo.ensureIndexes();

  const app = await buildApp({
    cols: mongo.collections,
    jwt,
    internalKey: env.internalKey,
    commercialUrl: env.commercialUrl,
    gatewayUrl: env.gatewayInternalUrl,
    gatewayPublicUrl: env.gatewayPublicUrl,
    // 请求日志走 buildApp 里可读的 onResponse 钩子（@nw/shared logger），不用 pino JSON。
    logger: false,
  });

  const shutdown = async () => {
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
  });
}

main().catch((e) => {
  log.error('metaserver failed to start', { err: (e as Error).stack ?? String(e) });
  process.exit(1);
});
