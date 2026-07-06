// auctionsvc process bootstrap (auction task 3: service skeleton).
// AUCTION_DESIGN §9: standalone auction house service, decoupled from worldsvc/worldId.
// Only wires up config -> dedicated Mongo -> health-check HTTP listener; business logic (task 4) is not yet migrated.
import { createLogger, startHeartbeat } from '@nw/shared';
import { loadAuctionsvcEnv } from './config';
import { createAuctionMongo } from './db';
import { startHttpApi } from './httpApi';

async function main(): Promise<void> {
  const env = loadAuctionsvcEnv();

  const mongo = await createAuctionMongo(env.auctionMongoUri, env.auctionMongoDb);
  await mongo.ensureIndexes();

  const server = startHttpApi({ host: env.host, port: env.port });

  const shutdown = async (): Promise<void> => {
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[auctionsvc] started port=${env.port} db=${env.auctionMongoDb}`);
  startHeartbeat(createLogger('auctionsvc'));
}

main().catch((e) => {
  console.error('[auctionsvc] failed to start:', e);
  process.exit(1);
});
