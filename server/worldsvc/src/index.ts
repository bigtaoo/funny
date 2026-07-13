// worldsvc process bootstrap (S8-0 + S8-4 + S8-5): connect dedicated DB → optional Redis → services → public REST listen.
// SLG_DESIGN §14.1 P1: worldsvc is a public face (reverse proxy /world → this process; /auction moved to auctionsvc, §9 task 6).
import { SLG_MAP_W, SLG_MAP_H, createLogger, startHeartbeat, SlgShopPriceCache, internalHeaders } from '@nw/shared';
import { createWorldMongo } from './db';
import { connectRedis } from './redis';
import { WorldService } from './service';
import { SectService } from './sectService';
import { NationChannelService } from './nationChannelService';
import { MapTemplateService } from './mapTemplateService';
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

  // SLG shop price/effect override cache: polls admin for raw overrides + resolves locally (no DB connection,
  // refreshed every 30s; stale cache used when admin is unreachable, code defaults used if never fetched).
  const shopPrices = new SlgShopPriceCache({
    fetchAll: async () => {
      if (!env.adminInternalUrl) return [];
      const res = await fetch(`${env.adminInternalUrl}/admin/internal/slg-shop-prices`, {
        headers: internalHeaders('worldsvc', env.internalKey),
      });
      if (!res.ok) throw new Error(`admin slg-shop-prices ${res.status}`);
      const body = (await res.json()) as { items?: unknown[] };
      return Array.isArray(body.items) ? body.items : [];
    },
    onError: (e) => console.warn('[worldsvc] shop price refresh failed (keeping cache)', (e as Error).message),
  });
  if (env.adminInternalUrl) void shopPrices.start();

  const svc = new WorldService({
    cols: mongo.collections,
    redis,
    gateway,
    commercial,
    meta,
    mail,
    socialsvc,
    shopPrices,
    mapW: SLG_MAP_W,
    mapH: SLG_MAP_H,
    now: () => Date.now(),
  });

  const sectSvc = new SectService({
    cols: mongo.collections,
    commercial,
    gateway,
    socialsvc,
    meta,
    now: () => Date.now(),
  });

  const nationChannelSvc = new NationChannelService({
    cols: mongo.collections,
    gateway,
    commercial,
    socialsvc,
    meta,
    now: () => Date.now(),
  });

  const mapTemplateSvc = new MapTemplateService({ cols: mongo.collections, now: () => Date.now() });

  const scheduler = startScheduler(svc);

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    svc,
    sectSvc,
    nationChannelSvc,
    socialsvc,
    mapTemplateSvc,
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
