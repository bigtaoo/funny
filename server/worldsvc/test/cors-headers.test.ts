// Regression test for the 2026-07-28 CORS outage (COMM_AUDIT_INTERNAL_2026-07-28.md, P0-7 follow-up):
// the client sends X-NW-Platform on every request (ApiClient/base.ts), but worldsvc's hand-rolled
// access-control-allow-headers list never listed it, so browsers blocked every cross-origin request
// at preflight (curl bypassed preflight, masking the outage — this must be a real HTTP round-trip,
// not a unit check of the header string). No Mongo needed: /health and OPTIONS never touch WorldService.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { startHttpApi } from '../src/httpApi';
import type { WorldService } from '../src/service';
import type { SectService } from '../src/sectService';
import type { NationChannelService } from '../src/nationChannelService';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';
import type { MapTemplateService } from '../src/mapTemplateService';

function startServer() {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: 'test-secret', internalKey: 'k' },
    {} as unknown as WorldService,
    {} as unknown as SectService,
    {} as unknown as NationChannelService,
    {} as unknown as WorldSocialsvcClient,
    {} as unknown as MapTemplateService,
  );
  return new Promise<{ server: ReturnType<typeof startHttpApi>; baseUrl: string }>((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('worldsvc CORS headers', () => {
  it('allows the X-NW-Platform header the client always sends (preflight OPTIONS)', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/world/active-season`, { method: 'OPTIONS' });
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
