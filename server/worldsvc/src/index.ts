// worldsvc 进程引导（S8-0 + S8-4 + S8-5）：连专属库 → 可选 Redis → 各 Service → 公网 REST listen。
// SLG_DESIGN §14.1 P1：worldsvc 是第四公网面（反代 /world,/family,/auction → 此进程）。
import { SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo } from './db';
import { connectRedis } from './redis';
import { WorldService } from './service';
import { FamilyService } from './familyService';
import { SectService } from './sectService';
import { NationChannelService } from './nationChannelService';
import { AuctionService } from './auctionService';
import { startHttpApi } from './httpApi';
import { startScheduler } from './scheduler';
import { HttpWorldGatewayClient } from './gatewayClient';
import { HttpWorldCommercialClient, nullWorldCommercialClient } from './commercialClient';
import { HttpWorldMetaClient, nullWorldMetaClient } from './metaClient';
import { HttpWorldMailClient, nullWorldMailClient } from './mailClient';
import { loadWorldsvcEnv } from './config';

async function main(): Promise<void> {
  const env = loadWorldsvcEnv();

  const mongo = await createWorldMongo(env.worldMongoUri, env.worldMongoDb);
  await mongo.ensureIndexes();

  const redis = await connectRedis(env.redisUrl);

  // redis 传入 gateway client：宗门频道扇出走 Redis pub/sub（缺省降级为 O(n) HTTP push）。
  const gateway = new HttpWorldGatewayClient(env.gatewayInternalUrl ?? null, env.internalKey, redis);

  const commercial = env.commercialInternalUrl
    ? new HttpWorldCommercialClient(env.commercialInternalUrl, env.internalKey)
    : nullWorldCommercialClient;

  const meta = env.metaInternalUrl
    ? new HttpWorldMetaClient(env.metaInternalUrl, env.internalKey)
    : nullWorldMetaClient;

  // 系统邮件复用 meta 内部端点（赛季结算发奖，§17.5）。
  const mail = env.metaInternalUrl
    ? new HttpWorldMailClient(env.metaInternalUrl, env.internalKey)
    : nullWorldMailClient;

  const svc = new WorldService({
    cols: mongo.collections,
    redis,
    gateway,
    commercial,
    meta,
    mail,
    mapW: SLG_MAP_W,
    mapH: SLG_MAP_H,
    now: () => Date.now(),
  });

  const familySvc = new FamilyService({
    cols: mongo.collections,
    gateway,
    now: () => Date.now(),
  });

  const sectSvc = new SectService({
    cols: mongo.collections,
    commercial,
    gateway,
    now: () => Date.now(),
  });

  const nationChannelSvc = new NationChannelService({
    cols: mongo.collections,
    gateway,
    now: () => Date.now(),
  });

  const auctionSvc = new AuctionService({
    cols: mongo.collections,
    commercial,
    meta,
    now: () => Date.now(),
  });

  const scheduler = startScheduler(svc, auctionSvc);

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    svc,
    familySvc,
    sectSvc,
    nationChannelSvc,
    auctionSvc,
  );

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    server.close();
    if (redis) await redis.quit().catch(() => {});
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `worldsvc public REST on :${env.port}; db=${env.worldMongoDb}; ` +
      `map=${SLG_MAP_W}x${SLG_MAP_H}; redis=${redis ? 'on' : 'off'}; ` +
      `gateway=${gateway.available ? 'on' : 'off'}; ` +
      `commercial=${commercial.available ? 'on' : 'off'}; meta=${meta.available ? 'on' : 'off'}`,
  );
}

main().catch((e) => {
  console.error('worldsvc failed to start:', e);
  process.exit(1);
});
