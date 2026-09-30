// C5-b token revocation (shared/src/tokenRevocation.ts): a validly signed token of a revoked (purged)
// account gets 410 ACCOUNT_DELETED on every public /social/* route, before any handler runs; tokens of other
// accounts and callers built without a list are unaffected. No Mongo: the services are never reached.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { TokenRevocationList, signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { FamilyService } from '../src/familyService';
import type { FriendService } from '../src/friendService';
import type { MailService } from '../src/mailService';
import type { SocialGatewayClient } from '../src/gatewayClient';
import type { SocialMetaClient } from '../src/metaClient';

const jwt = { secret: 'test-secret' };

async function startServer(tokenRevocations: TokenRevocationList | null) {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: jwt.secret, internalKey: 'k', tokenRevocations },
    {} as unknown as FamilyService,
    {} as unknown as FriendService,
    {} as unknown as MailService,
    {} as unknown as SocialGatewayClient,
    {} as unknown as SocialMetaClient,
  );
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function revoked(accountId: string): Promise<TokenRevocationList> {
  const list = new TokenRevocationList(async () => ({
    asOf: Date.now(),
    revocations: [{ accountId, revokedAt: Date.now() + 1000 }],
  }));
  await list.refresh();
  return list;
}

const get = (baseUrl: string, accountId: string) =>
  fetch(`${baseUrl}/social/no-such-route`, { headers: { authorization: `Bearer ${signToken(accountId, jwt)}` } });

describe('socialsvc token revocation', () => {
  it('answers 410 ACCOUNT_DELETED for a revoked account, and passes other accounts through to routing', async () => {
    const { server, baseUrl } = await startServer(await revoked('gone'));
    try {
      const res = await get(baseUrl, 'gone');
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
      const other = await get(baseUrl, 'alive');
      expect([401, 410]).not.toContain(other.status); // authenticated; the unknown path is the router's business
    } finally {
      server.close();
    }
  });

  it('skips the check when no list is wired (no metaserver URL)', async () => {
    const { server, baseUrl } = await startServer(null);
    try {
      expect([401, 410]).not.toContain((await get(baseUrl, 'gone')).status);
    } finally {
      server.close();
    }
  });
});
