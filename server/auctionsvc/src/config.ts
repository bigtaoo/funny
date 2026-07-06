// auctionsvc environment variables (auction task 3: service skeleton only, no business routes yet).
// AUCTION_DESIGN §9: standalone auction service, decoupled from worldsvc/worldId. Dedicated database,
// reuses the meta JWT for verifyToken signature verification only (does not connect to the accounts database).
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface AuctionsvcEnv extends ServerEnv {
  port: number;
  host: string;
  /** Dedicated database Mongo URI (defaults to NW_MONGO_URI). */
  auctionMongoUri: string;
  /** Dedicated database name (physically separate from meta/commercial/world). */
  auctionMongoDb: string;
}

export function loadAuctionsvcEnv(): AuctionsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_AUCTION_PORT ?? 18086),
    host: process.env.NW_AUCTION_HOST ?? '0.0.0.0',
    auctionMongoUri: process.env.NW_AUCTION_MONGO_URI ?? base.mongoUri,
    auctionMongoDb: process.env.NW_AUCTION_MONGO_DB ?? 'notebook_wars_auction',
  };
}
