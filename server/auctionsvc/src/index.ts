// auctionsvc process bootstrap (auction task 4): connect dedicated DB → services → public REST listen → expiry scheduler.
// AUCTION_DESIGN §9: standalone auction house service, decoupled from worldsvc/worldId.
import { createLogger, startHeartbeat } from '@nw/shared';
import { loadAuctionsvcEnv } from './config';
import { createAuctionMongo } from './db';
import { AuctionService } from './auctionService';
import { startHttpApi } from './httpApi';
import { startScheduler } from './scheduler';
import { HttpAuctionCommercialClient, nullAuctionCommercialClient } from './commercialClient';
import { HttpAuctionMetaClient, nullAuctionMetaClient } from './metaClient';
import { HttpAuctionMailClient, nullAuctionMailClient } from './mailClient';

async function main(): Promise<void> {
  const env = loadAuctionsvcEnv();

  const mongo = await createAuctionMongo(env.auctionMongoUri, env.auctionMongoDb);
  await mongo.ensureIndexes();

  const commercial = env.commercialInternalUrl
    ? new HttpAuctionCommercialClient(env.commercialInternalUrl, env.internalKey)
    : nullAuctionCommercialClient;

  const meta = env.metaInternalUrl
    ? new HttpAuctionMetaClient(env.metaInternalUrl, env.internalKey)
    : nullAuctionMetaClient;

  // System mail reuses the meta internal endpoint (escrow delivery/return).
  const mail = env.metaInternalUrl
    ? new HttpAuctionMailClient(env.metaInternalUrl, env.internalKey)
    : nullAuctionMailClient;

  const auctionSvc = new AuctionService({
    cols: mongo.collections,
    commercial,
    meta,
    mail,
    now: () => Date.now(),
  });

  const scheduler = startScheduler(auctionSvc);

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    auctionSvc,
  );

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `[auctionsvc] started port=${env.port} db=${env.auctionMongoDb}; ` +
      `commercial=${commercial.available ? 'on' : 'off'}; meta=${meta.available ? 'on' : 'off'}`,
  );
  startHeartbeat(createLogger('auctionsvc'));
}

main().catch((e) => {
  console.error('[auctionsvc] failed to start:', e);
  process.exit(1);
});
