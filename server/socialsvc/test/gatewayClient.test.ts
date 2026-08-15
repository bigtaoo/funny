// HttpSocialGatewayClient unit tests (previously 31% coverage — the e2e suites all use the in-memory
// FakeGateway from ./harness, never the real fetch-based implementation). Mocks globalThis.fetch, same
// convention as gateway's own matchsvcClient.test.ts / botsvc's socialClient.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpSocialGatewayClient, nullSocialGatewayClient, type SocialPushMsg } from '../src/gatewayClient';

const KEY = 'k-internal';
const BASE = 'http://gateway:8090';
const MSG: SocialPushMsg = { kind: 'friend_presence', publicId: '100000001', online: true };

interface Call { url: string; method: string | undefined; body: Record<string, unknown>; key: string | undefined }

function install(status = 200, body: unknown = { ok: true }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : {}, key: headers['x-internal-key'] });
    return { ok: status >= 200 && status < 300, status, json: async () => body, body: null } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

describe('HttpSocialGatewayClient', () => {
  let calls: Call[];
  beforeEach(() => { calls = install(); });
  afterEach(() => vi.restoreAllMocks());

  it('available reflects whether baseUrl is configured', () => {
    expect(new HttpSocialGatewayClient(BASE, KEY).available).toBe(true);
    expect(new HttpSocialGatewayClient(null, KEY).available).toBe(false);
  });

  describe('push', () => {
    it('POSTs to /gw/push with accountId + msg', async () => {
      await new HttpSocialGatewayClient(BASE, KEY).push('acc-a', MSG);
      expect(calls).toEqual([{ url: `${BASE}/gw/push`, method: 'POST', body: { accountId: 'acc-a', msg: MSG }, key: KEY }]);
    });
    it('baseUrl absent -> no-op, no request sent', async () => {
      await new HttpSocialGatewayClient(null, KEY).push('acc-a', MSG);
      expect(calls).toEqual([]);
    });
  });

  describe('pushMany', () => {
    it('empty accountIds -> no-op, no request sent', async () => {
      await new HttpSocialGatewayClient(BASE, KEY).pushMany([], MSG);
      expect(calls).toEqual([]);
    });
    it('delegates to pushBatch with one target per accountId, same msg', async () => {
      await new HttpSocialGatewayClient(BASE, KEY).pushMany(['acc-a', 'acc-b'], MSG);
      expect(calls).toEqual([{ url: `${BASE}/gw/push/batch`, method: 'POST', body: { targets: [{ accountId: 'acc-a', msg: MSG }, { accountId: 'acc-b', msg: MSG }] }, key: KEY }]);
    });
  });

  describe('pushBatch', () => {
    it('POSTs to /gw/push/batch with the targets array verbatim', async () => {
      const targets = [{ accountId: 'acc-a', msg: MSG }, { accountId: 'acc-b', msg: { kind: 'mail_new' as const, mailId: 'm1', hasAttachment: false } }];
      await new HttpSocialGatewayClient(BASE, KEY).pushBatch(targets);
      expect(calls).toEqual([{ url: `${BASE}/gw/push/batch`, method: 'POST', body: { targets }, key: KEY }]);
    });
    it('empty targets -> no-op', async () => {
      await new HttpSocialGatewayClient(BASE, KEY).pushBatch([]);
      expect(calls).toEqual([]);
    });
    it('baseUrl absent -> no-op', async () => {
      await new HttpSocialGatewayClient(null, KEY).pushBatch([{ accountId: 'a', msg: MSG }]);
      expect(calls).toEqual([]);
    });
  });

  describe('presence', () => {
    it('GETs /gw/presence with a comma-joined accountIds query, returns the body', async () => {
      calls = install(200, { 'acc-a': true, 'acc-b': false });
      const r = await new HttpSocialGatewayClient(BASE, KEY).presence(['acc-a', 'acc-b']);
      expect(r).toEqual({ 'acc-a': true, 'acc-b': false });
      expect(calls[0]!.url).toBe(`${BASE}/gw/presence?accounts=acc-a%2Cacc-b`);
    });
    it('empty accountIds -> {} without a request', async () => {
      expect(await new HttpSocialGatewayClient(BASE, KEY).presence([])).toEqual({});
      expect(calls).toEqual([]);
    });
    it('baseUrl absent -> {} without a request', async () => {
      expect(await new HttpSocialGatewayClient(null, KEY).presence(['acc-a'])).toEqual({});
      expect(calls).toEqual([]);
    });
    it('a failed request degrades to {} (everyone shown offline)', async () => {
      calls = install(500, {});
      expect(await new HttpSocialGatewayClient(BASE, KEY).presence(['acc-a'])).toEqual({});
    });
  });

  describe('invalidateFriends', () => {
    it('POSTs to /gw/social/invalidate with accountId', async () => {
      await new HttpSocialGatewayClient(BASE, KEY).invalidateFriends('acc-a');
      expect(calls).toEqual([{ url: `${BASE}/gw/social/invalidate`, method: 'POST', body: { accountId: 'acc-a' }, key: KEY }]);
    });
    it('baseUrl absent -> no-op', async () => {
      await new HttpSocialGatewayClient(null, KEY).invalidateFriends('acc-a');
      expect(calls).toEqual([]);
    });
  });
});

describe('nullSocialGatewayClient', () => {
  it('reports unavailable and every method no-ops / degrades to empty', async () => {
    expect(nullSocialGatewayClient.available).toBe(false);
    await expect(nullSocialGatewayClient.push('a', MSG)).resolves.toBeUndefined();
    await expect(nullSocialGatewayClient.pushMany(['a'], MSG)).resolves.toBeUndefined();
    await expect(nullSocialGatewayClient.pushBatch([{ accountId: 'a', msg: MSG }])).resolves.toBeUndefined();
    expect(await nullSocialGatewayClient.presence(['a'])).toEqual({});
    await expect(nullSocialGatewayClient.invalidateFriends('a')).resolves.toBeUndefined();
  });
});
