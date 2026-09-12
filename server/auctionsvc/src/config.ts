// auctionsvc environment variables (auction task 4: business routes wired up).
// AUCTION_DESIGN §9: standalone auction service, decoupled from worldsvc/worldId. Dedicated database,
// reuses the meta JWT for verifyToken signature verification only (does not connect to the accounts database).
import { DEV_MONGO_URI, loadServerEnv, requiredEnv, type ServerEnv } from '@nw/shared';

export interface AuctionsvcEnv extends ServerEnv {
  port: number;
  host: string;
  /** Mongo URI for `notebook_wars_auction` — this service's OWN least-privilege login.
   *  Never falls back to another service's variable; unset means the local dev Mongo (ADR-090). */
  auctionMongoUri: string;
  /** Dedicated database name (physically separate from meta/commercial/world). */
  auctionMongoDb: string;
  /** meta internal HTTP base URL (material/equipment/card/skin escrow-grant); if absent, item trading not supported. */
  metaInternalUrl: string | undefined;
  /** commercial internal HTTP base URL (deduct buyer coins / pay seller); if absent, coin trading not supported. */
  commercialInternalUrl: string | undefined;
}

export function loadAuctionsvcEnv(): AuctionsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_AUCTION_PORT ?? 18086),
    host: process.env.NW_AUCTION_HOST ?? '0.0.0.0',
    auctionMongoUri: requiredEnv('NW_AUCTION_MONGO_URI', DEV_MONGO_URI),
    auctionMongoDb: process.env.NW_AUCTION_MONGO_DB ?? 'notebook_wars_auction',
    metaInternalUrl: process.env.NW_META_INTERNAL_URL || undefined,
    commercialInternalUrl: process.env.NW_COMMERCIAL_INTERNAL_URL || undefined,
  };
}
