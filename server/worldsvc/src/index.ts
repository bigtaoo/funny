// worldsvc process bootstrap (S8-0 + S8-4 + S8-5): connect dedicated DB → optional Redis → services → public REST listen.
// SLG_DESIGN §14.1 P1: worldsvc is a public face (reverse proxy /world → this process; /auction moved to auctionsvc, §9 task 6).
import { SLG_MAP_W, SLG_MAP_H, createLogger, startHeartbeat, startEventLoopMonitor, SlgShopPriceCache, WordlistCache, fetchInternalJson } from '@nw/shared';
import { createWorldMongo } from './db';
import { connectRedis } from './redis';
import { WorldService } from './service';
import { SectService } from './sectService';
import { NationChannelService } from './nationChannelService';
import { MapTemplateService } from './mapTemplateService';
import { startHttpApi, routeTimings } from './httpApi';
import { startScheduler } from './scheduler';
import { HttpWorldGatewayClient } from './gatewayClient';
import { HttpWorldCommercialClient, nullWorldCommercialClient } from './commercialClient';
import { HttpWorldMetaClient, nullWorldMetaClient } from './metaClient';
import { HttpWorldMailClient, nullWorldMailClient } from './mailClient';
import { HttpWorldSocialsvcClient, nullWorldSocialsvcClient } from './socialsvcClient';
import { loadWorldsvcEnv } from './config';
import { getComputeBackend, shutdownComputeBackend } from './compute';

async function main(): Promise<void> {
  const env = loadWorldsvcEnv();

  const mongo = await createWorldMongo(env.worldMongoUri, env.worldMongoDb);
  await mongo.ensureIndexes();
  await mongo.runMigrations();

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
      const res = await fetchInternalJson<{ items?: unknown[] }>(`${env.adminInternalUrl}/admin/internal/slg-shop-prices`, {
        caller: 'worldsvc',
        key: env.internalKey,
        timeoutMs: 5000,
        label: '/admin/internal/slg-shop-prices',
      });
      // Throw on failure so the cache keeps its previous (stale) values via onError.
      if (!res.ok) throw new Error(`admin slg-shop-prices ${res.status}${res.error ? ` (${res.error})` : ''}`);
      const items = res.body?.items;
      return Array.isArray(items) ? items : [];
    },
    onError: (e) => console.warn('[worldsvc] shop price refresh failed (keeping cache)', (e as Error).message),
  });
  if (env.adminInternalUrl) void shopPrices.start();

  // Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2): same polling shape
  // as shopPrices above — no DB connection to admin, stale cache used when unreachable, code defaults
  // used if never fetched.
  const wordlists = new WordlistCache({
    fetchAll: async () => {
      if (!env.adminInternalUrl) return [];
      const res = await fetchInternalJson<{ items?: unknown[] }>(`${env.adminInternalUrl}/admin/internal/moderation-wordlists`, {
        caller: 'worldsvc',
        key: env.internalKey,
        timeoutMs: 5000,
        label: '/admin/internal/moderation-wordlists',
      });
      if (!res.ok) throw new Error(`admin moderation-wordlists ${res.status}${res.error ? ` (${res.error})` : ''}`);
      const items = res.body?.items;
      return Array.isArray(items) ? items : [];
    },
    onError: (e) => console.warn('[worldsvc] wordlist refresh failed (keeping cache)', (e as Error).message),
  });
  if (env.adminInternalUrl) void wordlists.start();

  const svc = new WorldService({
    cols: mongo.collections,
    redis,
    gateway,
    commercial,
    meta,
    mail,
    socialsvc,
    shopPrices,
    wordlists,
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
    wordlists,
    now: () => Date.now(),
  });

  const nationChannelSvc = new NationChannelService({
    cols: mongo.collections,
    gateway,
    commercial,
    socialsvc,
    meta,
    wordlists,
    now: () => Date.now(),
  });

  const mapTemplateSvc = new MapTemplateService({ cols: mongo.collections, now: () => Date.now() });

  const scheduler = startScheduler(svc, { autoSettleSeasons: env.autoSettleSeasons, timings: routeTimings });

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
    await shutdownComputeBackend();
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
  // worldsvc-concurrency-2026-09-05 phase 0: the SLG concurrency work is entirely about wall-clock time
  // spent NOT serving requests, and none of it is visible in ordinary logs (nothing errors; each query
  // looks fast; the process just stops). The loop monitor warns on the spot for any stall >=250ms; the
  // heartbeat carries the rolling loop percentiles plus the slowest routes so a regression shows up in
  // Grafana without anyone having to be watching at the time.
  const hbLog = createLogger('worldsvc');
  const loopMonitor = startEventLoopMonitor(hbLog);
  const compute = getComputeBackend();
  startHeartbeat(hbLog, {
    extra: () => ({ compute: compute.name, loopLagMs: loopMonitor.drain(), routes: routeTimings.drain() }),
  });

  // Warm the per-world terrain/connectivity index on every compute worker before players arrive
  // (worldsvc-concurrency-2026-09-05 phase 1). Building it costs ~2.5s per world per worker; paying that
  // here means the first marches after a deploy are as fast as the rest, instead of a handful of orders
  // each stalling one worker. Best-effort and non-blocking: a failure just restores the old lazy build.
  //
  // Capped deliberately: each worker keeps a bounded LRU of these indexes (getMapTerrainIndex in
  // @nw/shared), so warming more worlds than that cache holds would evict what it had just built and burn
  // the boot window doing it. Beyond the cap the old lazy build takes over, which is correct, just slower
  // on first use.
  const WARM_WORLD_LIMIT = 4;
  void mongo.collections.worlds
    .find({ status: 'active' }, { projection: { _id: 1 }, limit: WARM_WORLD_LIMIT })
    .toArray()
    .then(async (worlds) => {
      for (const w of worlds) {
        const t0 = Date.now();
        await compute.warmWorld(w._id, SLG_MAP_W, SLG_MAP_H);
        hbLog.info('compute path index warmed', { world: w._id, ms: Date.now() - t0 });
      }
    })
    .catch((e) => hbLog.warn('compute path index warmup failed (falling back to lazy build)', { err: (e as Error).message }));
}

main().catch((e) => {
  console.error('worldsvc failed to start:', e);
  process.exit(1);
});
