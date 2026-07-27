// P0-14 (comm-audit-2026-07-27 finding B15): auctionsvc's catch-all used to send the raw exception
// message straight to the client (`err(ErrorCode.INTERNAL, (e as Error).message)`) and never logged it
// server-side — an unhandled failure (a DB error, a bug) could leak internal details to a player and
// left ops with nothing to debug from. No Mongo needed: a mock AuctionService throws a plain Error and
// a real HTTP request is made against startHttpApi() on an ephemeral port.
import { describe, it, expect, afterAll } from 'vitest';
import { signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { AuctionService } from '../src/auctionService';
import type { AddressInfo } from 'net';

const JWT_SECRET = 'test-secret';
const ACC = 'acc-1';

function startServer(auctionSvc: Partial<AuctionService>): Promise<{ server: ReturnType<typeof startHttpApi>; baseUrl: string }> {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: JWT_SECRET, internalKey: 'k' },
    auctionSvc as unknown as AuctionService,
  );
  return new Promise((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('auctionsvc unhandled-error sanitization', () => {
  it('an unexpected exception returns a generic message, never the raw error text', async () => {
    const secretDetail = 'connection failed: mongodb://admin:hunter2@internal-db:27017/auction';
    const { server, baseUrl } = await startServer({
      listAuctions: async () => { throw new Error(secretDetail); },
    });
    try {
      const res = await fetch(`${baseUrl}/auction/list`, {
        headers: { authorization: `Bearer ${signToken(ACC, { secret: JWT_SECRET })}` },
      });
      expect(res.status).toBe(500);
      const body = await res.json() as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toBe('internal server error');
      expect(body.error.message).not.toContain(secretDetail);
      expect(body.error.message).not.toContain('mongodb://');
      expect(body.error.message).not.toContain('hunter2');
    } finally {
      server.close();
    }
  });

  it('a business SlgError still surfaces its real code + message (only truly unexpected errors are sanitized)', async () => {
    const { SlgError } = await import('@nw/shared');
    const { server, baseUrl } = await startServer({
      listAuctions: async () => { throw new SlgError('AUCTION_NOT_FOUND', 'listing not found'); },
    });
    try {
      const res = await fetch(`${baseUrl}/auction/list`, {
        headers: { authorization: `Bearer ${signToken(ACC, { secret: JWT_SECRET })}` },
      });
      const body = await res.json() as { ok: boolean; error: { code: string; message: string } };
      expect(body.error.code).toBe('AUCTION_NOT_FOUND');
      expect(body.error.message).toBe('listing not found');
    } finally {
      server.close();
    }
  });
});
