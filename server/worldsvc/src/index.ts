// worldsvc process bootstrap (S8-0 + S8-4 + S8-5): connect dedicated DB → optional Redis → services → public REST listen.
// SLG_DESIGN §14.1 P1: worldsvc is the fourth public face (reverse proxy /world,/auction → this process).
import { SLG_MAP_W, SLG_MAP_H, createLogger, startHeartbeat } from '@nw/shared';
import { createWorldMongo } from './db';
import { connectRedis } from './redis';
import { WorldService } from './service';
import { SectService } from './sectService';
import { NationChannelService } from './nationChannelService';
import { AuctionService } from './auctionService';
import { startHttpApi } from './httpApi';
import { startScheduler } from './scheduler';
import { HttpWorldGatewayClient } from './gatewayClient';
import { HttpWorldCommercialClient, nullWorldCommercialClient } from './commercialClient';
import { HttpWorldMetaClient, nullWorldMetaClient } from './metaClient';
import { HttpWorldMailClient, nullWorldMailClient } from './mailClient';
import { HttpWorldSocialsvcClient, nullWorldSocialsvcClient } from './socialsvcClient';
import { loadWorldsvcEnv } from './config';

async function main(): Promise<void> {
  const env = loadWorldsvcEnv();

  const mongo = await createWorldMongo(env.worldMongoUri, env.worldMongoDb);
  await mongo.ensureIndexes();

  const redis = await connectRedis(env.redisUrl);

  // Redis passed to gateway client: sect channel fan-out uses Redis pub/sub (falls back to O(n) HTTP push when unavailable).
  const gateway = new HttpWorldGatewayClient(env.gatewayInternalUrl ?? null, env.internalKey, redis);

  const commercial = env.commercialInternalUrl
    ? new HttpWorldCommercialClient(env.commercialInternalUrl, env.internalKey)
    : nullWorldCommercialClient;

  const meta = env.metaInternalUrl
    ? new HttpWorldMetaClient(env.metaInternalUrl, env.internalKey)
    : nullWorldMetaClient;

  // System mail reuses the meta internal endpoint (season settlement reward dispatch, §17.5).
  const mail = env.metaInternalUrl
    ? new HttpWorldMailClient(env.metaInternalUrl, env.internalKey)
    : nullWorldMailClient;

  // socialsvc internal client (P1: family route proxy + channel push delegation + familyId mirror).
  const socialsvc = env.socialsvcInternalUrl
    ? new HttpWorldSocialsvcClient(env.socialsvcInternalUrl, env.internalKey)
    : nullWorldSocialsvcClient;

  const svc = new WorldService({
    cols: mongo.collections,
    redis,
    gateway,
    commercial,
    meta,
    mail,
    socialsvc,
    mapW: SLG_MAP_W,
    mapH: SLG_MAP_H,
    now: () => Date.now(),
  });

  const sectSvc = new SectService({
    cols: mongo.collections,
    commercial,
    gateway,
    socialsvc,
    now: () => Date.now(),
  });

  const nationChannelSvc = new NationChannelService({
    cols: mongo.collections,
    gateway,
    commercial,
    socialsvc,
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
    sectSvc,
    nationChannelSvc,
    auctionSvc,
    socialsvc,
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
      `commercial=${commercial.available ? 'on' : 'off'}; meta=${meta.available ? 'on' : 'off'}; socialsvc=${socialsvc.available ? 'on' : 'off'}`,
  );
  startHeartbeat(createLogger('worldsvc')); // liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  console.error('worldsvc failed to start:', e);
  process.exit(1);
});
