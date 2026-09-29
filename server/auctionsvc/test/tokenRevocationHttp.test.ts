// C5-b token revocation (shared/src/tokenRevocation.ts): a validly signed token of a revoked (purged)
// account gets 410 ACCOUNT_DELETED before any /auction/* handler runs. Same no-Mongo `Partial<AuctionService>`
// pattern as httpApi-routes.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { TokenRevocationList, signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { AuctionService } from '../src/auctionService';

const jwt = { secret: 'test-secret' };
let server: ReturnType<typeof startHttpApi> | undefined;
afterEach(() => { server?.close(); server = undefined; });

describe('auctionsvc token revocation', () => {
  it('answers 410 ACCOUNT_DELETED for a revoked account; other accounts reach the handler', async () => {
    const list = new TokenRevocationList(async () => ({
      asOf: Date.now(),
      revocations: [{ accountId: 'gone', revokedAt: Date.now() + 1000 }],
    }));
    await list.refresh();
    const seen: string[] = [];
    const svc: Partial<AuctionService> = {
      getMyListings: async (accountId: string) => { seen.push(accountId); return []; },
    };
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: jwt.secret, internalKey: 'k', tokenRevocations: list },
      svc as unknown as AuctionService,
    );
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (accountId: string) =>
      fetch(`${base}/auction/mine`, { headers: { authorization: `Bearer ${signToken(accountId, jwt)}` } });

    const res = await get('gone');
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
    expect([401, 410]).not.toContain((await get('alive')).status);
    expect(seen).toEqual(['alive']);
  });
});
