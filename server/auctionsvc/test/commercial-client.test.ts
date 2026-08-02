// HttpAuctionCommercialClient unit test: commercial's /internal/spend always answers HTTP 200,
// carrying business failures (INSUFFICIENT_FUNDS) in the JSON body as {ok:false, error}. Regression
// test for a bug where spend() only checked res.ok (HTTP status) and never the body, so a buyer with
// insufficient coins still had their auction purchase go through uncharged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlgError, ErrorCode } from '@nw/shared';
import { HttpAuctionCommercialClient } from '../src/commercialClient';

const KEY = 'k-internal';
let nextSpendBody: unknown = { ok: true, coinsAfter: 0 };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextSpendBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpAuctionCommercialClient.spend', () => {
  it('ok:true → resolves without throwing', async () => {
    nextSpendBody = { ok: true, coinsAfter: 100 };
    const c = new HttpAuctionCommercialClient(base, KEY);
    await expect(c.spend('buyer1', 1200, 'auction_buy:x')).resolves.toBeUndefined();
  });

  it('HTTP 200 with ok:false (INSUFFICIENT_FUNDS) → throws, does not silently succeed', async () => {
    nextSpendBody = { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const c = new HttpAuctionCommercialClient(base, KEY);
    await expect(c.spend('buyer1', 1200, 'auction_buy:x')).rejects.toThrow('INSUFFICIENT_FUNDS');
  });

  // Regression test for [[business-errors-surface-as-500-2026-08-02]]: spend() used to wrap every
  // failure in a plain Error, so httpApi.ts's `instanceof SlgError` catch never matched and a buyer
  // with insufficient coins saw a generic 500 "internal server error" instead of the real
  // INSUFFICIENT_FUNDS code (402). Assert the thrown error is a properly-coded SlgError now.
  it('HTTP 200 with ok:false (INSUFFICIENT_FUNDS) → throws a SlgError with the real code, not a generic 500', async () => {
    nextSpendBody = { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const c = new HttpAuctionCommercialClient(base, KEY);
    try {
      await c.spend('buyer1', 1200, 'auction_buy:x');
      expect.unreachable('spend() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    }
  });

  it('an unrecognized error string still falls back to a plain Error (generic 500 stays generic for genuinely unexpected failures)', async () => {
    nextSpendBody = { ok: false, error: 'something weird commercial never actually returns' };
    const c = new HttpAuctionCommercialClient(base, KEY);
    try {
      await c.spend('buyer1', 1200, 'auction_buy:z');
      expect.unreachable('spend() should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(SlgError);
      expect((e as Error).message).toBe('something weird commercial never actually returns');
    }
  });
});
