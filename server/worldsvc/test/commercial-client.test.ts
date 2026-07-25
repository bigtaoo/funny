// HttpWorldCommercialClient unit test: commercial's /internal/spend always answers HTTP 200,
// carrying business failures (INSUFFICIENT_FUNDS) in the JSON body as {ok:false, error}. Regression
// test for a bug where spend() only checked res.ok (HTTP status) and never the body, so SLG coin
// sinks (building speedup / shop / world chat / sect create / relocation) would silently succeed
// even when the account had insufficient coins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWorldCommercialClient } from '../src/commercialClient';

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

describe('HttpWorldCommercialClient.spend', () => {
  it('ok:true → resolves without throwing', async () => {
    nextSpendBody = { ok: true, coinsAfter: 100 };
    const c = new HttpWorldCommercialClient(base, KEY);
    await expect(c.spend('acct1', 500, 'speedup:x')).resolves.toBeUndefined();
  });

  it('HTTP 200 with ok:false (INSUFFICIENT_FUNDS) → throws, does not silently succeed', async () => {
    nextSpendBody = { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const c = new HttpWorldCommercialClient(base, KEY);
    await expect(c.spend('acct1', 500, 'speedup:x')).rejects.toThrow('INSUFFICIENT_FUNDS');
  });
});
