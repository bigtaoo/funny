// auctionsvc MongoDB (auction task 4): auctions / auctionDaily / auctionPrices collections.
// Dedicated database notebook_wars_auction, physically isolated from meta/commercial/world.
// Migrated from server/worldsvc/src/db.ts — all documents drop the worldId field (AUCTION_DESIGN §9,
// auction is an account-scoped全服 market, not tied to any SLG world/shard).
import { MongoClient, type Collection, type Db, type MongoClientOptions } from 'mongodb';
import type { AuctionStatus } from '@nw/shared';

export interface AuctionDoc {
  _id: string; // auctionId
  sellerId: string;
  itemType: string;
  item: Record<string, unknown>;
  qty: number;
  price: number; // fixed-price: unit transaction price; auction: meaningless after bidding starts (use startPrice/topBid), retained for backward-compatible browse sorting
  currency: string;
  designatedBuyerId?: string;
  expireAt: number; // ms (expiry settled by scanner: refund seller escrow / finalize auction bid; not TTL auto-delete, see ensureIndexes note)
  status: AuctionStatus;
  buyerId?: string;
  /** Transaction timestamp ms (written when status→sold). Anomaly auditing (D/G7) windows by this; legacy documents fall back to parsing listing ts from _id. */
  soldAt?: number;
  // ── B Auction bidding (AUCTION_DESIGN §4.B). saleMode defaults to 'fixed' (backward-compatible with existing fixed-price listings) ──
  saleMode?: 'fixed' | 'auction';
  startPrice?: number;   // auction starting unit price
  buyoutPrice?: number;  // auction buyout unit price (optional)
  topBid?: { bidderId: string; amount: number; ts: number }; // current highest bid (unit price, coins already escrowed)
  rev: number;
}

/** C Daily quota counter (AUCTION_DESIGN §4.C). _id = `${accountId}:${dayKey}`, TTL auto-cleared. */
export interface AuctionDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string; // server UTC day boundary YYYY-MM-DD
  lists: number;  // new listings created today
  buys: number;   // purchases / bids placed today
  expiresAt: Date; // BSON Date, TTL anchor field
}

/** G Price guardrail sliding window (AUCTION_DESIGN §4.G). _id = category, stores the last N transaction unit prices. */
export interface AuctionPriceDoc {
  _id: string;
  category: string; // material category (material:scrap…); equipment category equip:{defId}
  prices: number[]; // last N transaction unit prices (newest at tail, length ≤ AUCTION_PRICE_WINDOW_N)
}

export interface AuctionCollections {
  auctions: Collection<AuctionDoc>;
  auctionDaily: Collection<AuctionDailyDoc>;
  auctionPrices: Collection<AuctionPriceDoc>;
}

export interface AuctionMongo {
  client: MongoClient;
  db: Db;
  collections: AuctionCollections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createAuctionMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<AuctionMongo> {
  let client: MongoClient;
  try {
    client = new MongoClient(uri, options);
    await client.connect();
  } catch (e) {
    const redacted = uri.replace(/:\/\/[^@]*@/, '://***@');
    console.error(`[auctionsvc] MongoDB connection failed uri=${redacted} db=${dbName}`, e);
    throw e;
  }

  const db = client.db(dbName);
  const collections: AuctionCollections = {
    auctions: db.collection<AuctionDoc>('auctions'),
    auctionDaily: db.collection<AuctionDailyDoc>('auctionDaily'),
    auctionPrices: db.collection<AuctionPriceDoc>('auctionPrices'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.auctions.createIndex({ itemType: 1, status: 1 });
    await collections.auctions.createIndex({ sellerId: 1 });
    await collections.auctions.createIndex({ designatedBuyerId: 1 });
    // Note: auctions.expireAt is intentionally NOT a TTL index — expiry requires settlement (refund seller escrow); handled by the scanner using this index;
    // TTL auto-delete would discard escrowed goods before settlement.
    await collections.auctions.createIndex({ expireAt: 1 });
    // C Daily quota: TTL auto-cleared (expiresAt is BSON Date; Mongo TTL only works on Date).
    await collections.auctionDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
