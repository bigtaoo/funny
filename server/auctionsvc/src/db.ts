// auctionsvc MongoDB (auction task 3: connection factory only).
// Dedicated database notebook_wars_auction, physically isolated from meta/commercial/world.
// Collections land in auction task 4 alongside the migrated business logic (AUCTION_DESIGN §5/§9).
import { MongoClient, type Db } from 'mongodb';

export interface AuctionMongo {
  client: MongoClient;
  db: Db;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createAuctionMongo(uri: string, dbName: string): Promise<AuctionMongo> {
  let client: MongoClient;
  try {
    client = new MongoClient(uri);
    await client.connect();
  } catch (e) {
    const redacted = uri.replace(/:\/\/[^@]*@/, '://***@');
    console.error(`[auctionsvc] MongoDB connection failed uri=${redacted} db=${dbName}`, e);
    throw e;
  }

  const db = client.db(dbName);

  async function ensureIndexes(): Promise<void> {
    // No collections yet — created in auction task 4 with the migrated auctions collection.
  }

  return {
    client,
    db,
    ensureIndexes,
    close: () => client.close(),
  };
}
