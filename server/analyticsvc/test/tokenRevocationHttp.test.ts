// C5-b token revocation (shared/src/tokenRevocation.ts): analytics never rejects an event batch, but a
// revoked (purged) account's token must not tie new events to the erased user_id — the batch is ingested
// as anonymous instead. No Mongo: the service is a recording fake.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { TokenRevocationList, createInternalAuth, signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { AnalyticsService } from '../src/service';

const jwt = { secret: 'test-secret' };

describe('analyticsvc token revocation', () => {
  it('ingests a revoked account\'s batch without its user_id, other accounts keep theirs', async () => {
    const list = new TokenRevocationList(async () => ({
      asOf: Date.now(),
      revocations: [{ accountId: 'gone', revokedAt: Date.now() + 1000 }],
    }));
    await list.refresh();
    const userIds: (string | undefined)[] = [];
    const svc = { ingestEvents: async (_b: unknown, userId: string | undefined) => { userIds.push(userId); } };
    const server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: jwt.secret, internalAuth: createInternalAuth({ legacyKey: 'k' }), tokenRevocations: list },
      svc as unknown as AnalyticsService,
    );
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (accountId: string) =>
      fetch(`${base}/analytics/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(accountId, jwt)}` },
        body: JSON.stringify({ consent: true, events: [{ name: 'app_open', ts: Date.now(), device_id: 'd1', session_id: 's1' }] }),
      });
    try {
      expect((await post('gone')).status).toBe(200);
      expect((await post('alive')).status).toBe(200);
      expect(userIds).toEqual([undefined, 'alive']);
    } finally {
      server.close();
    }
  });
});
