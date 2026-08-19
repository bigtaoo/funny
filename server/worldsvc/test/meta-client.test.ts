// HttpWorldMetaClient / nullWorldMetaClient unit tests: fixture node:http server for meta's
// /internal/materials/grant · /internal/profile · /internal/account/batch-profiles ·
// /internal/save-fields · /internal/title/grant.
//
// getSaveFields' query-string edge cases (cardIds encoding/omission) are already covered by
// test/meta-client-save-fields.test.ts — this file only adds the success-body / failure-status /
// null-baseUrl paths that file doesn't touch, plus every other method on the client.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWorldMetaClient, nullWorldMetaClient, type PlayerProfile, type SaveFields } from '../src/metaClient';

const KEY = 'k-internal';

interface RecordedReq {
  method: string;
  url: string;
  body: unknown;
}

let server: Server;
let base: string;
let lastReq: RecordedReq | null = null;
let requestCount = 0;
let nextStatus = 200;
let nextBody: unknown = {};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      requestCount++;
      lastReq = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  nextStatus = 200;
  nextBody = {};
  lastReq = null;
  requestCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpWorldMetaClient.available', () => {
  it('true when baseUrl is set, false when null', () => {
    expect(new HttpWorldMetaClient(base, KEY).available).toBe(true);
    expect(new HttpWorldMetaClient(null, KEY).available).toBe(false);
  });
});

describe('HttpWorldMetaClient.grantMaterial', () => {
  it('success → POST /internal/materials/grant with { accountId, material, qty, orderId }, no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.grantMaterial('acc1', 'wood', 10, 'order-1')).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/materials/grant');
    expect(lastReq?.body).toEqual({ accountId: 'acc1', material: 'wood', qty: 10, orderId: 'order-1' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('non-2xx → logs via console.error with full context, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.grantMaterial('acc1', 'wood', 10, 'order-1')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [logMsg, ctx] = errSpy.mock.calls[0]!;
    expect(logMsg).toBe('[worldsvc] meta.grantMaterial failed');
    expect(ctx).toMatchObject({ accountId: 'acc1', material: 'wood', qty: 10, orderId: 'order-1', status: 500 });
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldMetaClient(null, KEY);
    await expect(c.grantMaterial('acc1', 'wood', 10, 'order-1')).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldMetaClient.getProfile', () => {
  const profile: PlayerProfile = { publicId: '123456789', displayName: 'Alice', equippedTitle: 'Champion' };

  it('success → GET /internal/profile?accountId=... (encoded), returns the parsed body', async () => {
    nextBody = profile;
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.getProfile('acc 1')).resolves.toEqual(profile);
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe(`/internal/profile?accountId=${encodeURIComponent('acc 1')}`);
  });

  it('non-2xx → resolves null', async () => {
    nextStatus = 404;
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.getProfile('acc1')).resolves.toBeNull();
  });

  it('baseUrl null → resolves null without a request', async () => {
    const c = new HttpWorldMetaClient(null, KEY);
    await expect(c.getProfile('acc1')).resolves.toBeNull();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldMetaClient.batchProfiles', () => {
  const p1: PlayerProfile = { publicId: '1', displayName: 'A' };
  const p2: PlayerProfile = { publicId: '2', displayName: 'B' };

  it('success → POST /internal/account/batch-profiles with { accountIds }, returns a Map of the returned profiles', async () => {
    nextBody = { profiles: { acc1: p1, acc2: p2 } };
    const c = new HttpWorldMetaClient(base, KEY);
    const result = await c.batchProfiles(['acc1', 'acc2', 'acc3']);
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/account/batch-profiles');
    expect(lastReq?.body).toEqual({ accountIds: ['acc1', 'acc2', 'acc3'] });
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('acc1')).toEqual(p1);
    expect(result.get('acc2')).toEqual(p2);
    expect(result.has('acc3')).toBe(false);
  });

  it('response with no profiles field → resolves an empty Map', async () => {
    nextBody = {};
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.batchProfiles(['acc1'])).resolves.toEqual(new Map());
  });

  it('non-2xx → resolves an empty Map', async () => {
    nextStatus = 500;
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.batchProfiles(['acc1'])).resolves.toEqual(new Map());
  });

  it('empty accountIds → resolves an empty Map without a request', async () => {
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.batchProfiles([])).resolves.toEqual(new Map());
    expect(requestCount).toBe(0);
  });

  it('baseUrl null → resolves an empty Map without a request', async () => {
    const c = new HttpWorldMetaClient(null, KEY);
    await expect(c.batchProfiles(['acc1'])).resolves.toEqual(new Map());
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldMetaClient.getSaveFields (response handling, beyond the query-string cases)', () => {
  it('success → GET /internal/save-fields, returns the parsed SaveFields body', async () => {
    const saveFields = { cardInv: { c1: { cardId: 'c1', level: 1 } } } as unknown as SaveFields;
    nextBody = saveFields;
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.getSaveFields('acc1')).resolves.toEqual(saveFields);
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe('/internal/save-fields?accountId=acc1');
  });

  it('non-2xx → resolves null', async () => {
    nextStatus = 500;
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.getSaveFields('acc1')).resolves.toBeNull();
  });

  it('baseUrl null → resolves null without a request', async () => {
    const c = new HttpWorldMetaClient(null, KEY);
    await expect(c.getSaveFields('acc1')).resolves.toBeNull();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldMetaClient.grantTitle', () => {
  it('success → POST /internal/title/grant with { accountId, titleId }, no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.grantTitle('acc1', 'title-champion')).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/title/grant');
    expect(lastReq?.body).toEqual({ accountId: 'acc1', titleId: 'title-champion' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('non-2xx → logs via console.error, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMetaClient(base, KEY);
    await expect(c.grantTitle('acc1', 'title-champion')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [logMsg, ctx] = errSpy.mock.calls[0]!;
    expect(logMsg).toBe('[worldsvc] meta.grantTitle failed');
    expect(ctx).toMatchObject({ accountId: 'acc1', titleId: 'title-champion', status: 500 });
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldMetaClient(null, KEY);
    await expect(c.grantTitle('acc1', 'title-champion')).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('nullWorldMetaClient', () => {
  it('available is false; every method returns its documented default', async () => {
    expect(nullWorldMetaClient.available).toBe(false);
    await expect(nullWorldMetaClient.grantMaterial('a', 'wood', 1, 'o')).resolves.toBeUndefined();
    await expect(nullWorldMetaClient.getProfile('a')).resolves.toBeNull();
    await expect(nullWorldMetaClient.batchProfiles(['a'])).resolves.toEqual(new Map());
    await expect(nullWorldMetaClient.getSaveFields('a')).resolves.toBeNull();
    await expect(nullWorldMetaClient.grantTitle('a', 't')).resolves.toBeUndefined();
  });
});
