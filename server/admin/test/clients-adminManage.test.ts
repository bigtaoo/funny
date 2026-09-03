// See clients-lookupAndQueue.test.ts header for why this file exists (2026-08-14 coverage backlog).
// This group: clients that THROW on failure instead of degrading (ops-initiated writes where the
// frontend must see the error) — events (+ its EventsClientError, reused by gachaPools/promo/paddleEvents),
// gachaPools, promo, paddleEvents, ladder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return { ...actual, fetchInternalJson: vi.fn() };
});

import { fetchInternalJson } from '@nw/shared';
import { HttpEventsClient, EventsClientError } from '../src/clients/events';
import { HttpGachaPoolsClient } from '../src/clients/gachaPools';
import { HttpPromoClient } from '../src/clients/promo';
import { HttpPaddleEventsClient } from '../src/clients/paddleEvents';
import { HttpLadderClient } from '../src/clients/ladder';

const fetchMock = fetchInternalJson as unknown as Mock;

afterEach(() => {
  fetchMock.mockReset();
});

describe('EventsClientError', () => {
  it('carries the http status and message', () => {
    const e = new EventsClientError(503, 'meta not configured');
    expect(e.status).toBe(503);
    expect(e.message).toBe('meta not configured');
    expect(e.name).toBe('EventsClientError');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('HttpEventsClient', () => {
  it('list returns [] unconfigured (no throw) and maps a good response', async () => {
    expect(await new HttpEventsClient(null, 'k').list()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { events: [{ id: 'e1' }] } });
    expect(await new HttpEventsClient('http://meta', 'k').list()).toEqual([{ id: 'e1' }]);
  });

  it('list throws EventsClientError on failure, using status||502', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'timeout' });
    await expect(new HttpEventsClient('http://meta', 'k').list()).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValue({ ok: false, status: 503, body: null });
    await expect(new HttpEventsClient('http://meta', 'k').list()).rejects.toMatchObject({ status: 503 });
  });

  it('create/update delegate to write(), posting/patching the right path+body and returning the event', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { event: { id: 'e2' } } });
    const input = { name: 'spring sale' } as never;
    const created = await new HttpEventsClient('http://meta', 'k').create(input);
    expect(created).toEqual({ id: 'e2' });
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://meta/admin/events', expect.objectContaining({ method: 'POST', body: input })]);

    await new HttpEventsClient('http://meta', 'k').update('e2', input);
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://meta/admin/events/e2', expect.objectContaining({ method: 'PATCH', body: input })]);
  });

  it('write throws EventsClientError(503) unconfigured, and surfaces detail/error/network-error messages', async () => {
    await expect(new HttpEventsClient(null, 'k').create({} as never)).rejects.toMatchObject({ status: 503 });

    fetchMock.mockResolvedValue({ ok: false, status: 400, body: { detail: 'bad name' } });
    await expect(new HttpEventsClient('http://meta', 'k').create({} as never)).rejects.toMatchObject({ status: 400, message: 'bad name' });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpEventsClient('http://meta', 'k').create({} as never)).rejects.toMatchObject({ status: 200 });
  });

  it('remove throws unconfigured(503), on failure, and resolves on success', async () => {
    await expect(new HttpEventsClient(null, 'k').remove('e1')).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValue({ ok: false, status: 404, body: { error: 'not found' } });
    await expect(new HttpEventsClient('http://meta', 'k').remove('e1')).rejects.toMatchObject({ status: 404, message: 'not found' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpEventsClient('http://meta', 'k').remove('e1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://meta/admin/events/e1', expect.objectContaining({ method: 'DELETE' })]);
  });
});

describe('HttpGachaPoolsClient', () => {
  it('list returns [] unconfigured and throws on failure', async () => {
    expect(await new HttpGachaPoolsClient(null, 'k').list()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').list()).rejects.toMatchObject({ status: 500 });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { pools: [{ id: 'p1' }] } });
    expect(await new HttpGachaPoolsClient('http://meta', 'k').list()).toEqual([{ id: 'p1' }]);
  });

  it('createCustom throws unconfigured(503), on failure/missing id, and resolves the id on success', async () => {
    await expect(new HttpGachaPoolsClient(null, 'k').createCustom({} as never, 'admin')).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValue({ ok: false, status: 400, body: { detail: 'bad config' } });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').createCustom({} as never, 'admin')).rejects.toMatchObject({ message: 'bad config' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { id: 'p2' } });
    expect(await new HttpGachaPoolsClient('http://meta', 'k').createCustom({ categories: [] } as never, 'admin')).toEqual({ id: 'p2' });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: { categories: [], createdBy: 'admin' } });
  });

  it('close throws unconfigured(503), on failure/missing id, and resolves the id on success', async () => {
    await expect(new HttpGachaPoolsClient(null, 'k').close('p1')).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').close('p1')).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { id: 'p1' } });
    expect(await new HttpGachaPoolsClient('http://meta', 'k').close('p1')).toEqual({ id: 'p1' });
  });
});

describe('HttpPromoClient', () => {
  it('list returns [] unconfigured and throws on failure', async () => {
    expect(await new HttpPromoClient(null, 'k').list()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'boom' });
    await expect(new HttpPromoClient('http://meta', 'k').list()).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { codes: [{ _id: 'X10', coins: 100, redeemed: 2, createdBy: 'root', createdAt: 7 }] } });
    expect(await new HttpPromoClient('http://meta', 'k').list()).toEqual([{ code: 'X10', coins: 100, redeemed: 2, createdBy: 'root', createdAt: 7 }]);
  });

  // Regression (2026-08-20): this mock used to feed `{ code }` — the shape PromoCodeView *declares* —
  // so it agreed with the client's own type and proved nothing. commercial actually serves its
  // promoCodes documents verbatim, where `_id` IS the code (and its own route test pins that), so the
  // real response carries no `code` field at all. With the mock lying, the ops table's Code column came
  // back undefined against real services while every test stayed green.
  it('list renames the wire `_id` to `code` and never leaks `_id` downstream', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: { codes: [{ _id: 'WELCOME2026', coins: 250, totalLimit: 500, expiresAt: 99, note: 'launch', redeemed: 3, createdBy: 'adm-1', createdAt: 5 }] },
    });
    const [row] = await new HttpPromoClient('http://meta', 'k').list();
    expect(row).toEqual({ code: 'WELCOME2026', coins: 250, totalLimit: 500, expiresAt: 99, note: 'launch', redeemed: 3, createdBy: 'adm-1', createdAt: 5 });
    expect(row).not.toHaveProperty('_id');
  });

  // `available` is the flag PromoService's degrade branch reads (see promo.test.ts) — pinning it here
  // is what connects the two halves: unconfigured must be falsy there, or the service silently starts
  // calling a client with no base URL.
  it('available reflects whether a meta base URL was configured', () => {
    expect(new HttpPromoClient(null, 'k').available).toBe(false);
    expect(new HttpPromoClient('http://meta', 'k').available).toBe(true);
  });

  // The remaining `??` legs in this client are all "meta answered, but not with what we asked for"
  // shapes. They matter because the ops page renders whatever comes back: a swallowed undefined here
  // is an empty table or a blank error box, with nothing in the log to explain either.
  it('list treats a 200 with no `codes` array as an empty list, not a crash in the _id→code map', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpPromoClient('http://meta', 'k').list()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null });
    expect(await new HttpPromoClient('http://meta', 'k').list()).toEqual([]);
  });

  it('list reports a status-less network failure as 502 "network error" rather than "HTTP 0"/undefined', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null });
    await expect(new HttpPromoClient('http://meta', 'k').list()).rejects.toMatchObject({
      status: 502,
      message: 'list promo codes network error',
    });
  });

  // Note the status it carries: `r.status || 502` keeps the transport's 200, so the thrown error is
  // an EventsClientError(200). That is not a bug but it is only harmless because httpApi.ts's mapper
  // sends anything outside 400..599 as 502 — asserted here so the two halves stay in sync if either
  // side's fallback is ever changed.
  it('create rejects a 200 that omits the code — the caller would otherwise return { code: undefined } as success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpPromoClient('http://meta', 'k').create({ code: 'X10', coins: 1, createdBy: 'a' }))
      .rejects.toMatchObject({ status: 200, message: 'create promo code HTTP 200' });
  });

  it('create falls back through body.error → r.error → "HTTP <status>" for its message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'socket hang up' });
    await expect(new HttpPromoClient('http://meta', 'k').create({ code: 'X10', coins: 1, createdBy: 'a' }))
      .rejects.toMatchObject({ message: 'socket hang up' });
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(new HttpPromoClient('http://meta', 'k').create({ code: 'X10', coins: 1, createdBy: 'a' }))
      .rejects.toMatchObject({ message: 'create promo code HTTP 500' });
    // status 0 (never reached meta) → 502, the one leg list already covers but create did not.
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null });
    await expect(new HttpPromoClient('http://meta', 'k').create({ code: 'X10', coins: 1, createdBy: 'a' }))
      .rejects.toMatchObject({ status: 502 });
  });

  it('create throws unconfigured(503), on failure/missing code, and resolves the code on success', async () => {
    const args = { code: 'X10', coins: 100, createdBy: 'admin' };
    await expect(new HttpPromoClient(null, 'k').create(args)).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValue({ ok: false, status: 409, body: { error: 'duplicate code' } });
    await expect(new HttpPromoClient('http://meta', 'k').create(args)).rejects.toMatchObject({ message: 'duplicate code' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { code: 'X10' } });
    expect(await new HttpPromoClient('http://meta', 'k').create(args)).toEqual({ code: 'X10' });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST', body: args });
  });
});

describe('HttpPaddleEventsClient', () => {
  it('list returns [] unconfigured, builds the query string, and throws on failure', async () => {
    expect(await new HttpPaddleEventsClient(null, 'k').list({})).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { events: [{ transactionId: 't1' }] } });
    const rows = await new HttpPaddleEventsClient('http://meta', 'k').list({ accountId: 'a1', transactionId: 't1', limit: 5 });
    expect(rows).toEqual([{ transactionId: 't1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/admin/paddle/events?accountId=a1&transactionId=t1&limit=5');

    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(new HttpPaddleEventsClient('http://meta', 'k').list({})).rejects.toThrow();
  });
});

describe('HttpLadderClient', () => {
  it('rollSeason throws unconfigured, on failure/missing season, and resolves the season on success', async () => {
    await expect(new HttpLadderClient(null, 'k').rollSeason()).rejects.toThrow('meta not configured');
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'timeout' });
    await expect(new HttpLadderClient('http://meta', 'k').rollSeason()).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpLadderClient('http://meta', 'k').rollSeason()).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { season: { seasonNo: 3, startAt: 1, endAt: 2, state: 'active' } } });
    expect(await new HttpLadderClient('http://meta', 'k').rollSeason()).toEqual({ seasonNo: 3, startAt: 1, endAt: 2, state: 'active' });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST' });
  });

  it('getCurrentSeason degrades to null unconfigured/on failure and maps a good response', async () => {
    expect(await new HttpLadderClient(null, 'k').getCurrentSeason()).toBeNull();
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpLadderClient('http://meta', 'k').getCurrentSeason()).toBeNull();
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { season: { seasonNo: 3, startAt: 1, endAt: 2, state: 'active' } } });
    expect(await new HttpLadderClient('http://meta', 'k').getCurrentSeason()).toEqual({ seasonNo: 3, startAt: 1, endAt: 2, state: 'active' });
  });
});

// ── Error-message fallback chains (2026-09-03 branch-coverage pass) ─────────────────────────────
// The `HttpGachaPoolsClient` group above covers each method's happy path plus one failure, which is
// enough for 100% LINE coverage but left 9 of its 24 branches unexecuted: every method builds its
// thrown message out of a `detail ?? error ?? r.error ?? template` chain and its status out of
// `r.status || 502`, and only the first link of each had ever run. The chain is what an operator
// actually reads when a pool edit is refused, so which link wins matters: `detail` is meta's own
// validation prose, `r.error` is a transport failure, and the template is the last resort. A
// network error (status 0) is also the only case that must NOT surface as "HTTP 0".
describe('HttpGachaPoolsClient error-message and status fallbacks', () => {
  it('list maps a transport failure (status 0) to 502 and names the transport error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'timeout' });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').list()).rejects.toMatchObject({
      status: 502,
      message: 'list gacha pools timeout',
    });
  });

  it('list falls back to "network error" when the transport failed without a message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').list()).rejects.toMatchObject({
      message: 'list gacha pools network error',
    });
  });

  it('list treats a 200 with no pools array as an empty list', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpGachaPoolsClient('http://meta', 'k').list()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null });
    expect(await new HttpGachaPoolsClient('http://meta', 'k').list()).toEqual([]);
  });

  it('createCustom prefers detail, then error, then the transport error, then the HTTP template', async () => {
    const client = new HttpGachaPoolsClient('http://meta', 'k');
    fetchMock.mockResolvedValue({ ok: false, status: 400, body: { detail: 'detail wins', error: 'ignored' } });
    await expect(client.createCustom({} as never, 'adm-1')).rejects.toMatchObject({ message: 'detail wins' });
    fetchMock.mockResolvedValue({ ok: false, status: 409, body: { error: 'pool exists' } });
    await expect(client.createCustom({} as never, 'adm-1')).rejects.toMatchObject({ status: 409, message: 'pool exists' });
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'socket hang up' });
    await expect(client.createCustom({} as never, 'adm-1')).rejects.toMatchObject({ status: 502, message: 'socket hang up' });
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(client.createCustom({} as never, 'adm-1')).rejects.toMatchObject({ message: 'create pool HTTP 500' });
  });

  it('createCustom rejects a 200 that carries no pool id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').createCustom({} as never, 'adm-1')).rejects.toMatchObject({
      status: 200,
      message: 'create pool HTTP 200',
    });
  });

  it('close prefers the body error, then the transport error, then the HTTP template', async () => {
    const client = new HttpGachaPoolsClient('http://meta', 'k');
    fetchMock.mockResolvedValue({ ok: false, status: 404, body: { error: 'no such pool' } });
    await expect(client.close('p1')).rejects.toMatchObject({ status: 404, message: 'no such pool' });
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'socket hang up' });
    await expect(client.close('p1')).rejects.toMatchObject({ status: 502, message: 'socket hang up' });
    fetchMock.mockResolvedValue({ ok: false, status: 503, body: null });
    await expect(client.close('p1')).rejects.toMatchObject({ message: 'close pool HTTP 503' });
  });

  it('close rejects a 200 that carries no pool id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(new HttpGachaPoolsClient('http://meta', 'k').close('p1')).rejects.toMatchObject({
      message: 'close pool HTTP 200',
    });
  });
});
