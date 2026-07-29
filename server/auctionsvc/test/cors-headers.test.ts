// Regression test for the 2026-07-28 CORS outage (COMM_AUDIT_INTERNAL_2026-07-28.md, P0-7 follow-up):
// the client sends X-NW-Platform on every request (ApiClient/base.ts), but auctionsvc's hand-rolled
// access-control-allow-headers list never listed it, so browsers blocked every cross-origin request
// at preflight (curl bypassed preflight, masking the outage — this must be a real HTTP round-trip,
// not a unit check of the header string). No Mongo needed, same pattern as httpApi-error-sanitization.test.ts.
import { describe, it, expect } from 'vitest';
import { startHttpApi } from '../src/httpApi';
import type { AuctionService } from '../src/auctionService';
import type { AddressInfo } from 'net';

function startServer() {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: 'test-secret', internalKey: 'k' },
    {} as unknown as AuctionService,
  );
  return new Promise<{ server: ReturnType<typeof startHttpApi>; baseUrl: string }>((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('auctionsvc CORS headers', () => {
  it('allows the X-NW-Platform header the client always sends (preflight OPTIONS)', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/auction/list`, { method: 'OPTIONS' });
      const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowHeaders.toLowerCase().split(',').map((h) => h.trim())).toContain('x-nw-platform');
    } finally {
      server.close();
    }
  });
});
