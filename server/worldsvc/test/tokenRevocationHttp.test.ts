// C5-b token revocation (shared/src/tokenRevocation.ts): a validly signed token of a revoked (purged)
// account gets 410 ACCOUNT_DELETED before any /world/* handler runs — without it a leaked token could
// re-create the playerWorld the purge just erased. No Mongo: the services are never reached.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { TokenRevocationList, signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { WorldService } from '../src/service';
import type { SectService } from '../src/sectService';
import type { NationChannelService } from '../src/nationChannelService';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';
import type { MapTemplateService } from '../src/mapTemplateService';

const jwt = { secret: 'test-secret' };

async function startServer(tokenRevocations: TokenRevocationList | null) {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: jwt.secret, internalKey: 'k', tokenRevocations },
    {} as unknown as WorldService,
    {} as unknown as SectService,
    {} as unknown as NationChannelService,
    {} as unknown as WorldSocialsvcClient,
    {} as unknown as MapTemplateService,
  );
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('worldsvc token revocation', () => {
  it('answers 410 ACCOUNT_DELETED for a revoked account, and passes other accounts through to routing', async () => {
    const list = new TokenRevocationList(async () => ({
      asOf: Date.now(),
      revocations: [{ accountId: 'gone', revokedAt: Date.now() + 1000 }],
    }));
    await list.refresh();
    const { server, baseUrl } = await startServer(list);
    const get = (accountId: string) =>
      fetch(`${baseUrl}/world/no-such-route`, { headers: { authorization: `Bearer ${signToken(accountId, jwt)}` } });
    try {
      const res = await get('gone');
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
      expect([401, 410]).not.toContain((await get('alive')).status);
    } finally {
      server.close();
    }
  });
});
