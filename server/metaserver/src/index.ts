// metaserver 进程引导：连 Mongo → buildApp → listen。
// 反代将 /api/* 转到本进程（SERVER_API.md §0）。
import { createMongo, type JwtConfig } from '@nw/shared';
import { loadMetaEnv } from './config.js';
import { buildApp, SPEC_PATH } from './app.js';

async function main() {
  const env = loadMetaEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const mongo = await createMongo(env.mongoUri, env.mongoDb);
  await mongo.ensureIndexes();

  const app = await buildApp({
    cols: mongo.collections,
    jwt,
    internalKey: env.internalKey,
    logger: true,
  });

  const shutdown = async () => {
    await app.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
  app.log.info(`metaserver up on ${env.host}:${env.port}, spec=${SPEC_PATH}`);
}

main().catch((e) => {
  console.error('metaserver failed to start:', e);
  process.exit(1);
});
