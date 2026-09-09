// worldsvc responses must declare `content-length` (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §8, 2026-09-09).
//
// Not a cosmetic header. The reverse proxy in front of every public face now compresses JSON
// (`gzip` in client/nginx.conf, `encode zstd gzip` in server/Caddyfile) with a minimum-size threshold,
// and a proxy cannot honour a size threshold on a response whose size it does not know: with node's
// default chunked framing nginx compresses *everything*, and a 31-byte `/world/active-season` reply
// measured 51 bytes on the wire (gzip's own header is ~20 bytes). So the threshold in those configs is
// only real while `send()` keeps declaring the length — this is the test that keeps it honest.
//
// Like cors-headers.test.ts, these must be real HTTP round trips: the point is what node actually puts
// on the socket, which a unit check of the header object cannot see (node drops or rewrites
// content-length on its own for some statuses). No Mongo — /health and OPTIONS never touch WorldService.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import { signToken } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { WorldService } from '../src/service';
import type { SectService } from '../src/sectService';
import type { NationChannelService } from '../src/nationChannelService';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';
import type { MapTemplateService } from '../src/mapTemplateService';

const SECRET = 'test-secret';

function startServer(svc: Partial<WorldService> = {}) {
  const server = startHttpApi(
    { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'k' },
    svc as unknown as WorldService,
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

describe('worldsvc response framing', () => {
  it('declares content-length matching the body, and does not fall back to chunked', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.text();
      expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
      // The failure mode this guards is the fallback, so assert the fallback is gone by name.
      expect(res.headers.get('transfer-encoding')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('counts bytes, not characters, so a CJK payload is not truncated', async () => {
    // This one needs a body that is actually multi-byte. Written first against the plain 401 envelope,
    // it would NOT go red when byteLength was swapped for String.length — that envelope is pure ASCII,
    // where the two agree, so the assertion was passing for the wrong reason (the §7.4 lesson: a test
    // that refuses to fail under mutation is asserting something else). A real `getMap` response carries
    // `ownerName` straight from the meta profile, i.e. CJK display names, so the fake service returns
    // exactly that shape: with String.length the header under-declares by 2 bytes per CJK character and
    // the client gets a body cut off mid-JSON.
    const tiles = Array.from({ length: 40 }, (_, i) => ({
      x: i, y: i, type: 'territory', level: 3, visible: true, occupied: true, ownerName: `玩家清风明月${i}`,
    }));
    const { server, baseUrl } = await startServer({
      getMap: async () => ({ worldId: 'w', cx: 1, cy: 1, r: 1, tiles }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/world/map?worldId=w&cx=1&cy=1&r=1`, {
        headers: { authorization: `Bearer ${signToken('acct-1', { secret: SECRET })}` },
      });
      expect(res.status).toBe(200);
      const raw = Buffer.from(await res.arrayBuffer());
      expect(raw.byteLength).toBeGreaterThan(raw.toString('utf8').length); // the body really is multi-byte
      expect(res.headers.get('content-length')).toBe(String(raw.byteLength));
      expect(JSON.parse(raw.toString('utf8')).data.tiles).toHaveLength(40);
    } finally {
      server.close();
    }
  });

  it('sends no content-length and no body on a 204 (CORS preflight)', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/world/active-season`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      // A 204 must not carry a body; declaring a length for one is a protocol violation some proxies
      // reject outright. `send()` special-cases it — this is that branch.
      expect(res.headers.get('content-length')).toBeNull();
      expect(await res.text()).toBe('');
    } finally {
      server.close();
    }
  });
});
