// auctionsvc skeleton e2e (auction task 3/4): dedicated Mongo connects + /health returns 200.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createAuctionMongo, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import { startHttpApi } from '../src/httpApi';
import { nullAuctionCommercialClient } from '../src/commercialClient';
import { nullAuctionMetaClient } from '../src/metaClient';
import { nullAuctionMailClient } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_auction_test';

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB);
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[auctionsvc.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('auctionsvc skeleton e2e', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await mongo!.ensureIndexes();
    const auctionSvc = new AuctionService({
      cols: mongo!.collections,
      commercial: nullAuctionCommercialClient,
      meta: nullAuctionMetaClient,
      mail: nullAuctionMailClient,
      now: () => Date.now(),
    });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'test-secret', internalKey: 'test-internal-key' },
      auctionSvc,
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    await mongo!.close();
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: 'auctionsvc' });
  });
});
