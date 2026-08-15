// See clients-lookupAndQueue.test.ts header for why this file exists (2026-08-14 coverage backlog).
// This group: stats (fan-out merge of two upstreams), player (lookup/search/reset-password), mail
// (send/preview with a dedicated 404/501 "not yet available" branch).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return { ...actual, fetchInternalJson: vi.fn() };
});

import { fetchInternalJson } from '@nw/shared';
import { HttpStatsClient } from '../src/clients/stats';
import { HttpPlayerClient } from '../src/clients/player';
import { HttpMailDispatcher } from '../src/clients/mail';

const fetchMock = fetchInternalJson as unknown as Mock;

afterEach(() => {
  fetchMock.mockReset();
});

describe('HttpStatsClient', () => {
  it('available is true if either upstream is configured', () => {
    expect(new HttpStatsClient(null, null, 'k').available).toBe(false);
    expect(new HttpStatsClient('http://gw', null, 'k').available).toBe(true);
    expect(new HttpStatsClient(null, 'http://match', 'k').available).toBe(true);
  });

  it('fetchLive merges both upstreams, defaulting each field to 0 on partial failure', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('gw')) return { ok: true, status: 200, body: { online: 7 } };
      return { ok: false, status: 500, body: null };
    });
    const stats = await new HttpStatsClient('http://gw', 'http://match', 'k').fetchLive();
    expect(stats).toEqual({ online: 7, queue: 0, rooms: 0, gameInstances: 0, gameLoad: 0 });
  });

  it('fetchLive returns all zeros when neither upstream is configured, without calling out', async () => {
    expect(await new HttpStatsClient(null, null, 'k').fetchLive()).toEqual({ online: 0, queue: 0, rooms: 0, gameInstances: 0, gameLoad: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchLive reports full matchsvc stats when that upstream succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { queue: 3, rooms: 2, gameInstances: 1, gameLoad: 0.5 } });
    const stats = await new HttpStatsClient(null, 'http://match', 'k').fetchLive();
    expect(stats).toEqual({ online: 0, queue: 3, rooms: 2, gameInstances: 1, gameLoad: 0.5 });
  });
});

describe('HttpPlayerClient', () => {
  it('lookupByPublicId / lookupByAccountId build the right query string', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { publicId: '123456789' } });
    const c = new HttpPlayerClient('http://meta', 'k');
    await c.lookupByPublicId('123456789');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/player?publicId=123456789');
    await c.lookupByAccountId('acc-1');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/player?accountId=acc-1');
  });

  it('lookup returns null when unconfigured, on 404, and on any other failure', async () => {
    expect(await new HttpPlayerClient(null, 'k').lookupByPublicId('1')).toBeNull();
    fetchMock.mockResolvedValue({ ok: false, status: 404, body: null });
    expect(await new HttpPlayerClient('http://meta', 'k').lookupByPublicId('1')).toBeNull();
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'boom' });
    expect(await new HttpPlayerClient('http://meta', 'k').lookupByPublicId('1')).toBeNull();
  });

  it('search degrades to [] unconfigured/on failure and maps a good response', async () => {
    expect(await new HttpPlayerClient(null, 'k').search('q', 10)).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpPlayerClient('http://meta', 'k').search('q', 10)).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { players: [{ accountId: 'a1' }] } });
    expect(await new HttpPlayerClient('http://meta', 'k').search('q', 10)).toEqual([{ accountId: 'a1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/players/search?q=q&limit=10');
  });

  it('resetPassword: unconfigured / network error / http error / success', async () => {
    expect(await new HttpPlayerClient(null, 'k').resetPassword('a1', 'pw')).toEqual({ ok: false, error: 'player backend unavailable' });

    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'timeout' });
    expect(await new HttpPlayerClient('http://meta', 'k').resetPassword('a1', 'pw')).toEqual({ ok: false, error: 'request failed' });

    fetchMock.mockResolvedValue({ ok: false, status: 409, body: { error: 'no password credential' } });
    expect(await new HttpPlayerClient('http://meta', 'k').resetPassword('a1', 'pw')).toEqual({ ok: false, error: 'no password credential' });

    fetchMock.mockResolvedValue({ ok: false, status: 409, body: null });
    expect(await new HttpPlayerClient('http://meta', 'k').resetPassword('a1', 'pw')).toEqual({ ok: false, error: 'http 409' });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    const res = await new HttpPlayerClient('http://meta', 'k').resetPassword('a1', 'pw');
    expect(res).toEqual({ ok: true });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST', body: { password: 'pw' } });
  });
});

describe('HttpMailDispatcher', () => {
  it('available reflects metaBaseUrl', () => {
    expect(new HttpMailDispatcher(null, 'k').available).toBe(false);
    expect(new HttpMailDispatcher('http://meta', 'k').available).toBe(true);
  });

  const req = { dispatchKey: 'd1', scope: 'single' as const, target: { kind: 'account', accountId: 'a1' } as never, subject: 's', body: 'b', attachments: [], expireDays: 7 };

  it('send: unconfigured / not-yet-available (404,501) / network error / http error / success', async () => {
    expect(await new HttpMailDispatcher(null, 'k').send(req)).toEqual({ ok: false, error: 'mail backend unavailable' });

    fetchMock.mockResolvedValue({ ok: false, status: 404, body: null });
    expect(await new HttpMailDispatcher('http://meta', 'k').send(req)).toEqual({ ok: false, error: 'mail endpoint not yet available (S6-3)' });
    fetchMock.mockResolvedValue({ ok: false, status: 501, body: null });
    expect(await new HttpMailDispatcher('http://meta', 'k').send(req)).toEqual({ ok: false, error: 'mail endpoint not yet available (S6-3)' });

    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'network down' });
    expect(await new HttpMailDispatcher('http://meta', 'k').send(req)).toEqual({ ok: false, error: 'network down' });

    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpMailDispatcher('http://meta', 'k').send(req)).toEqual({ ok: false, error: 'mail send failed: HTTP 500' });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, recipientCount: 3 } });
    expect(await new HttpMailDispatcher('http://meta', 'k').send(req)).toEqual({ ok: true, recipientCount: 3 });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/mail/system/send');
  });

  it('preview: unconfigured / not-yet-available / network error / http error / success', async () => {
    const preview = { scope: 'global' as const, target: { kind: 'all' } as never };
    expect(await new HttpMailDispatcher(null, 'k').preview(preview)).toEqual({ ok: false, recipientCount: 0, error: 'mail backend unavailable' });

    fetchMock.mockResolvedValue({ ok: false, status: 501, body: null });
    expect(await new HttpMailDispatcher('http://meta', 'k').preview(preview)).toEqual({
      ok: false,
      recipientCount: 0,
      error: 'mail endpoint not yet available (S6-3)',
    });

    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'boom' });
    expect(await new HttpMailDispatcher('http://meta', 'k').preview(preview)).toEqual({ ok: false, recipientCount: 0, error: 'boom' });

    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpMailDispatcher('http://meta', 'k').preview(preview)).toEqual({ ok: false, recipientCount: 0, error: 'preview failed: HTTP 500' });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, recipientCount: 42 } });
    expect(await new HttpMailDispatcher('http://meta', 'k').preview(preview)).toEqual({ ok: true, recipientCount: 42 });
  });
});
