// worldsvc 进程引导（S8-0）：连专属库 → 可选 Redis → WorldService → 公网 REST listen。
// SLG_DESIGN §14.1 P1：worldsvc 是第四公网面（反代 /world,/family,/auction → 此进程）。
import { SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo } from './db';
import { connectRedis } from './redis';
import { WorldService } from './service';
import { startHttpApi } from './httpApi';
import { loadWorldsvcEnv } from './config';

async function main(): Promise<void> {
  const env = loadWorldsvcEnv();

  const mongo = await createWorldMongo(env.worldMongoUri, env.worldMongoDb);
  await mongo.ensureIndexes();

  const redis = await connectRedis(env.redisUrl);

  const svc = new WorldService({
    cols: mongo.collections,
    redis,
    mapW: SLG_MAP_W,
    mapH: SLG_MAP_H,
    now: () => Date.now(),
  });

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret },
    svc,
  );

  const shutdown = async (): Promise<void> => {
    server.close();
    if (redis) await redis.quit().catch(() => {});
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `worldsvc public REST on :${env.port}; db=${env.worldMongoDb}; ` +
      `map=${SLG_MAP_W}x${SLG_MAP_H}; redis=${redis ? 'on' : 'off'}`,
  );
}

main().catch((e) => {
  console.error('worldsvc failed to start:', e);
  process.exit(1);
});
