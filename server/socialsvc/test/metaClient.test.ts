// HttpSocialMetaClient unit tests (previously 25% coverage — the e2e suites all use the in-memory
// FakeMeta from ./harness, never the real fetch-based implementation). Mocks a real node:http fixture
// server, same convention as auctionsvc's meta-client.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpSocialMetaClient, nullSocialMetaClient } from '../src/metaClient';

const KEY = 'k-internal';
let nextStatus = 200;
let nextBody: unknown = {};
let lastPath = '';
let lastMethod = '';
let lastBody: Record<string, unknown> | undefined;

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
      lastPath = req.url ?? '';
      lastMethod = req.method ?? 'GET';
      const raw = await readBody(req);
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('HttpSocialMetaClient', () => {
  it('available is always true (no baseUrl-absent degraded mode for this client)', () => {
    expect(new HttpSocialMetaClient(base, KEY).available).toBe(true);
  });

  describe('resolveByPublicId', () => {
    it('found -> the resolved accountId + profile, hits the by-public-id endpoint', async () => {
      nextStatus = 200;
      nextBody = { accountId: 'acc-a', profile: { publicId: '100000001', displayName: 'Alice' } };
      const r = await new HttpSocialMetaClient(base, KEY).resolveByPublicId('100000001');
      expect(r).toEqual({ accountId: 'acc-a', profile: { publicId: '100000001', displayName: 'Alice' } });
      expect(lastMethod).toBe('GET');
      expect(lastPath).toBe('/internal/account/by-public-id/100000001');
    });
    it('not found (404) -> null', async () => {
      nextStatus = 404;
      nextBody = {};
      expect(await new HttpSocialMetaClient(base, KEY).resolveByPublicId('999999999')).toBeNull();
    });
  });

  describe('batchProfiles', () => {
    it('empty input -> empty map, no request sent', async () => {
      lastPath = 'unset';
      expect(await new HttpSocialMetaClient(base, KEY).batchProfiles([])).toEqual(new Map());
      expect(lastPath).toBe('unset');
    });
    it('success -> a Map keyed by accountId, POSTs the accountIds list', async () => {
      nextStatus = 200;
      nextBody = { profiles: { 'acc-a': { publicId: '1', displayName: 'A' }, 'acc-b': { publicId: '2', displayName: 'B' } } };
      const r = await new HttpSocialMetaClient(base, KEY).batchProfiles(['acc-a', 'acc-b']);
      expect(r).toEqual(new Map([['acc-a', { publicId: '1', displayName: 'A' }], ['acc-b', { publicId: '2', displayName: 'B' }]]));
      expect(lastMethod).toBe('POST');
      expect(lastPath).toBe('/internal/account/batch-profiles');
      expect(lastBody).toEqual({ accountIds: ['acc-a', 'acc-b'] });
    });
    it('a failure degrades to an empty map', async () => {
      nextStatus = 500;
      nextBody = {};
      expect(await new HttpSocialMetaClient(base, KEY).batchProfiles(['acc-a'])).toEqual(new Map());
    });
  });

  describe('getPlayerRankByPublicId', () => {
    it('found, with rank+elo -> both included', async () => {
      nextStatus = 200;
      nextBody = { accountId: 'acc-a', rank: 'gold', elo: 1500 };
      const r = await new HttpSocialMetaClient(base, KEY).getPlayerRankByPublicId('100000001');
      expect(r).toEqual({ accountId: 'acc-a', rank: 'gold', elo: 1500 });
      expect(lastPath).toBe('/internal/player?publicId=100000001');
    });
    it('found, no rank -> rank omitted (not present as undefined)', async () => {
      nextStatus = 200;
      nextBody = { accountId: 'acc-a', elo: 1000 };
      const r = await new HttpSocialMetaClient(base, KEY).getPlayerRankByPublicId('100000001');
      expect(r).toEqual({ accountId: 'acc-a', elo: 1000 });
      expect(r).not.toHaveProperty('rank');
    });
    it('not found (no accountId in body) -> null', async () => {
      nextStatus = 200;
      nextBody = {};
      expect(await new HttpSocialMetaClient(base, KEY).getPlayerRankByPublicId('999999999')).toBeNull();
    });
    it('a failed request -> null', async () => {
      nextStatus = 500;
      nextBody = {};
      expect(await new HttpSocialMetaClient(base, KEY).getPlayerRankByPublicId('100000001')).toBeNull();
    });
  });
});

describe('nullSocialMetaClient', () => {
  it('reports unavailable and every method degrades to its empty/null default', async () => {
    expect(nullSocialMetaClient.available).toBe(false);
    expect(await nullSocialMetaClient.resolveByPublicId('1')).toBeNull();
    expect(await nullSocialMetaClient.batchProfiles(['a'])).toEqual(new Map());
    expect(await nullSocialMetaClient.getPlayerRankByPublicId('1')).toBeNull();
  });
});
