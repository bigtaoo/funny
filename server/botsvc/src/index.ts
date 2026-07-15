// botsvc process bootstrap (BOTSVC_DESIGN §2). Owns no database; runs an internal admin HTTP face plus a
// scheduler loop that logs a fleet of bot accounts in/out against the real public APIs.
import { loadInternalAuth } from '@nw/shared';
import { loadBotsvcEnv } from './config';
import { generateBotPool } from './pool';
import { MetaClient } from './metaClient';
import { SocialClient } from './socialClient';
import { CommercialClient } from './commercialClient';
import { WorldClient } from './worldClient';
import { CapacityClient } from './capacityClient';
import { BotSession } from './bot';
import { Scheduler } from './scheduler';
import { startInternalHttp } from './internalHttp';

async function main(): Promise<void> {
  const env = loadBotsvcEnv();

  const meta = new MetaClient(env.metaBaseUrl);
  const social = new SocialClient(env.socialBaseUrl);
  const commercial = new CommercialClient(env.commercialInternalUrl, env.internalKey);
  const world = new WorldClient(env.worldBaseUrl);
  const capacity = new CapacityClient(env.gatewayInternalUrl, env.internalKey);

  const battleOpts = { gatewayWsUrl: env.gatewayWsUrl, chancePerTick: env.battleChancePerTick };
  const pool = generateBotPool(env.poolSize, env.deviceOffset).map(
    (identity) => new BotSession(identity, meta, social, commercial, world, battleOpts),
  );
  const scheduler = new Scheduler(pool, capacity, {
    targetOnline: env.targetOnline,
    shedStartAt: env.shedStartAt,
    shedFullAt: env.shedFullAt,
    batchSize: env.spawnBatch,
    upkeepConcurrency: env.upkeepConcurrency,
    upkeepRotations: env.upkeepRotations,
  });

  const server = startInternalHttp(
    { host: env.host, port: env.port, internalAuth: loadInternalAuth(env.internalKey) },
    scheduler,
  );

  const timer = setInterval(() => {
    scheduler.tick().catch((e) => console.error('botsvc tick failed:', e));
  }, env.tickMs);

  const shutdown = (): void => {
    clearInterval(timer);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`botsvc internal admin API on :${env.port}; pool=${env.poolSize}; targetOnline=${env.targetOnline}`);
}

main().catch((e) => {
  console.error('botsvc failed to start:', e);
  process.exit(1);
});
