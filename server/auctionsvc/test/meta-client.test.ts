// HttpAuctionMetaClient.deductMaterial unit test. meta's /internal/materials/deduct signals business
// errors via real HTTP status (402 insufficient / 404 save-not-found / 409 rev-conflict-exhausted /
// 400 bad request) — no `code` field like escrow*/skin* on this same client. Regression test for
// [[business-errors-surface-as-500-2026-08-02]]: deductMaterial() used to wrap every non-2xx in a plain
// Error regardless of status, so httpApi.ts's `instanceof SlgError` catch never matched and a routine
// "not enough material" surfaced to the seller as a generic 500 instead of the real error code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlgError, ErrorCode } from '@nw/shared';
import { HttpAuctionMetaClient } from '../src/metaClient';

const KEY = 'k-internal';
let nextStatus = 200;
let nextBody: unknown = { ok: true, remaining: 100 };

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
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpAuctionMetaClient.deductMaterial', () => {
  it('2xx → resolves without throwing', async () => {
    nextStatus = 200;
    nextBody = { ok: true, remaining: 100 };
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(c.deductMaterial('acct1', 'paper', 1, 'auction_list:x')).resolves.toBeUndefined();
  });

  it('402 insufficient materials → throws SlgError(INSUFFICIENT_MATERIALS), not a generic 500', async () => {
    nextStatus = 402;
    nextBody = { ok: false, error: 'insufficient materials' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:y');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.INSUFFICIENT_MATERIALS);
    }
  });

  it('404 save not found → throws SlgError(NOT_FOUND)', async () => {
    nextStatus = 404;
    nextBody = { ok: false, error: 'save not found' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:z');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('409 rev conflict exhausted → throws SlgError(REV_CONFLICT)', async () => {
    nextStatus = 409;
    nextBody = { ok: false, error: 'rev conflict, retry' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:w');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.REV_CONFLICT);
    }
  });

  it('400 bad request → throws SlgError(BAD_REQUEST)', async () => {
    nextStatus = 400;
    nextBody = { ok: false, error: 'accountId + material + qty (>0) required' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:v');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });

  it('an unrecognized 5xx status still falls back to a plain Error (genuinely unexpected failures stay generic)', async () => {
    nextStatus = 503;
    nextBody = { ok: false, error: 'service unavailable' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:u');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(SlgError);
      expect((e as Error).message).toBe('service unavailable');
    }
  });
});
