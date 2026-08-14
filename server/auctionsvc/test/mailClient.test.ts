// HttpAuctionMailClient unit tests (previously 0% coverage — no dedicated test file existed at all).
// Best-effort system-mail dispatch: never throws (delivery/return failures are logged, not propagated,
// so a mail outage never blocks settlement) — covers the not-configured no-op, the real-request body
// shape, the HTTP-level failure log, and the "HTTP 200 but {ok:false}" rejected-mail log (meta answers
// 200 even when the recipient is unknown or socialsvc persistence failed, so status alone can't detect
// a dropped mail).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAuctionMailClient, nullAuctionMailClient } from '../src/mailClient';

const KEY = 'k-internal';
let nextStatus = 200;
let nextBody: unknown = { ok: true };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;
let lastRequestBody: Record<string, unknown> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      lastRequestBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

describe('HttpAuctionMailClient', () => {
  it('available reflects whether baseUrl is configured', () => {
    expect(new HttpAuctionMailClient(base, KEY).available).toBe(true);
    expect(new HttpAuctionMailClient(null, KEY).available).toBe(false);
  });

  it('baseUrl absent -> no-op, no request sent at all', async () => {
    lastRequestBody = undefined;
    await new HttpAuctionMailClient(null, KEY).sendSystemMail('acc-a', 'dk-1', { subject: 's', body: 'b' });
    expect(lastRequestBody).toBeUndefined();
  });

  it('sends the full envelope to /internal/mail/system/send, defaulting attachments/expireDays when absent', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-1', { subject: 'Sold!', body: 'Your item sold.' });
    expect(lastRequestBody).toEqual({
      dispatchKey: 'dk-1', accountId: 'acc-a', subject: 'Sold!', body: 'Your item sold.', attachments: [], expireDays: 0,
    });
  });

  it('forwards attachments + expireDays verbatim when provided', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-2', {
      subject: 'Refund', body: 'Listing cancelled.', attachments: [{ kind: 'coins', count: 500 }], expireDays: 14,
    });
    expect(lastRequestBody).toMatchObject({ attachments: [{ kind: 'coins', count: 500 }], expireDays: 14 });
  });

  it('an HTTP-level failure (non-2xx) is logged, not thrown — mail is best-effort', async () => {
    nextStatus = 500;
    nextBody = {};
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-3', { subject: 's', body: 'b' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] mail.sendSystemMail failed', expect.objectContaining({ accountId: 'acc-a', dispatchKey: 'dk-3' }));
  });

  it('HTTP 200 but {ok:false} in the body (dropped mail) is also logged, not thrown', async () => {
    nextStatus = 200;
    nextBody = { ok: false, error: 'unknown recipient' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-4', { subject: 's', body: 'b' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] mail.sendSystemMail rejected', expect.objectContaining({ accountId: 'acc-a', dispatchKey: 'dk-4', err: 'unknown recipient' }));
  });
});

describe('nullAuctionMailClient', () => {
  it('reports unavailable and no-ops sendSystemMail', async () => {
    expect(nullAuctionMailClient.available).toBe(false);
    await expect(nullAuctionMailClient.sendSystemMail('acc-a', 'dk', { subject: 's', body: 'b' })).resolves.toBeUndefined();
  });
});
