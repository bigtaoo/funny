// HttpWorldMailClient / nullWorldMailClient unit tests: fixture node:http server standing in for
// meta's /internal/mail/system/send. Covers the two distinct failure shapes the real endpoint can
// produce (see ../src/mailClient.ts): a non-2xx HTTP status, and an HTTP-200-but-{ok:false} body
// (meta can't signal a dropped mail via status code alone).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWorldMailClient, nullWorldMailClient, type WorldMailContent } from '../src/mailClient';

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

const content: WorldMailContent = {
  subject: 'Season reward',
  body: 'Congrats',
};

describe('HttpWorldMailClient.available', () => {
  it('true when baseUrl is set, false when null', () => {
    expect(new HttpWorldMailClient(base, KEY).available).toBe(true);
    expect(new HttpWorldMailClient(null, KEY).available).toBe(false);
  });
});

describe('HttpWorldMailClient.sendSystemMail', () => {
  it('success → POST /internal/mail/system/send with defaults (attachments:[], expireDays:0), no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMailClient(base, KEY);
    await expect(c.sendSystemMail('acc1', 'dk-1', content)).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/mail/system/send');
    expect(lastReq?.body).toEqual({
      dispatchKey: 'dk-1',
      accountId: 'acc1',
      subject: 'Season reward',
      body: 'Congrats',
      attachments: [],
      expireDays: 0,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('attachments + expireDays are passed through when provided', async () => {
    const c = new HttpWorldMailClient(base, KEY);
    await c.sendSystemMail('acc1', 'dk-1', {
      subject: 'S',
      body: 'B',
      attachments: [{ kind: 'coins', count: 500 }],
      expireDays: 7,
    });
    expect(lastReq?.body).toMatchObject({
      attachments: [{ kind: 'coins', count: 500 }],
      expireDays: 7,
    });
  });

  it('HTTP ok:true body → resolves without console.error', async () => {
    nextBody = { ok: true };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMailClient(base, KEY);
    await expect(c.sendSystemMail('acc1', 'dk-1', content)).resolves.toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('non-2xx → logs "failed" via console.error with accountId/dispatchKey/status, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMailClient(base, KEY);
    await expect(c.sendSystemMail('acc1', 'dk-1', content)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [logMsg, ctx] = errSpy.mock.calls[0]!;
    expect(logMsg).toBe('[worldsvc] mail.sendSystemMail failed');
    expect(ctx).toMatchObject({ accountId: 'acc1', dispatchKey: 'dk-1', status: 500 });
  });

  it('HTTP 200 but body {ok:false} → logs "rejected" via console.error, does not throw', async () => {
    nextBody = { ok: false, error: 'UNKNOWN_RECIPIENT' };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldMailClient(base, KEY);
    await expect(c.sendSystemMail('acc1', 'dk-1', content)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [logMsg, ctx] = errSpy.mock.calls[0]!;
    expect(logMsg).toBe('[worldsvc] mail.sendSystemMail rejected');
    expect(ctx).toMatchObject({ accountId: 'acc1', dispatchKey: 'dk-1', err: 'UNKNOWN_RECIPIENT' });
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldMailClient(null, KEY);
    await expect(c.sendSystemMail('acc1', 'dk-1', content)).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('nullWorldMailClient', () => {
  it('available is false; sendSystemMail is a no-op', async () => {
    expect(nullWorldMailClient.available).toBe(false);
    await expect(nullWorldMailClient.sendSystemMail('a', 'dk', content)).resolves.toBeUndefined();
  });
});
