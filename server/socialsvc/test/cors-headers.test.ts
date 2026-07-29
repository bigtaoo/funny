// Regression for the 2026-07-29 audit fix: socialsvc's hand-rolled access-control-allow-headers list
// never listed X-NW-Platform, even though worldsvc/auctionsvc were both fixed for the exact same gap in
// the 2026-07-28 CORS outage (COMM_AUDIT_INTERNAL_2026-07-28.md, P0-7) — client/src/net/WorldApiClient.ts
// sends this header on every request, including family/friend/mail calls and /social/profile/:id/extra
// that hit socialsvc directly, so browsers blocked every cross-origin call at preflight (curl bypasses
// preflight, masking the outage — this must be a real HTTP round-trip, not a unit check of the string).
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { startHttpApi } from '../src/httpApi';
import type { FamilyService } from '../src/familyService';
import type { FriendService } from '../src/friendService';
import type { MailService } from '../src/mailService';
import type { SocialGatewayClient } from '../src/gatewayClient';
import type { SocialMetaClient } from '../src/metaClient';

function startServer() {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: 'test-secret', internalKey: 'k' },
    {} as unknown as FamilyService,
    {} as unknown as FriendService,
    {} as unknown as MailService,
    {} as unknown as SocialGatewayClient,
    {} as unknown as SocialMetaClient,
  );
  return new Promise<{ server: ReturnType<typeof startHttpApi>; baseUrl: string }>((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('socialsvc CORS headers', () => {
  it('allows the X-NW-Platform header the client always sends (preflight OPTIONS)', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/social/family`, { method: 'OPTIONS' });
      const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowHeaders.toLowerCase().split(',').map((h) => h.trim())).toContain('x-nw-platform');
    } finally {
      server.close();
    }
  });

  it('also carries it on real responses (GET /health)', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/health`);
      const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowHeaders.toLowerCase().split(',').map((h) => h.trim())).toContain('x-nw-platform');
    } finally {
      server.close();
    }
  });
});
