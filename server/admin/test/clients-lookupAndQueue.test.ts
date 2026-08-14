// Coverage backlog (2026-08-14, see claudedocs/server.md "测试覆盖率百分比工具"): admin's src/clients/*
// HTTP client wrappers were near-0% covered — they were only ever exercised transitively through
// AdminService e2e tests configured with metaBaseUrl=null (so `available` short-circuits before the
// fetchInternalJson call). This file (+ the 3 sibling clients-*.test.ts files) mocks @nw/shared's
// fetchInternalJson directly so every client's request-construction / response-mapping / degrade-on-
// failure branch actually executes. Grouped by "GET list + POST action, degrades to a safe default on
// any failure" shape (as opposed to the clients-adminManage.test.ts group, which throws instead).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return { ...actual, fetchInternalJson: vi.fn() };
});

import { fetchInternalJson } from '@nw/shared';
import { HttpAntiCheatClient } from '../src/clients/anticheat';
import { HttpMismatchClient } from '../src/clients/mismatch';
import { HttpPvpCardStatsClient } from '../src/clients/pvpCardStats';
import { HttpSuspiciousPveClient } from '../src/clients/suspiciousPve';
import { HttpFeedbackClient } from '../src/clients/feedback';
import { HttpAppealsClient } from '../src/clients/appeals';
import { HttpReportsClient } from '../src/clients/reports';
import { HttpEnforcementClient } from '../src/clients/enforcement';

const fetchMock = fetchInternalJson as unknown as Mock;

afterEach(() => {
  fetchMock.mockReset();
});

describe('HttpAntiCheatClient', () => {
  it('available reflects whether metaBaseUrl is configured', () => {
    expect(new HttpAntiCheatClient(null, 'k').available).toBe(false);
    expect(new HttpAntiCheatClient('http://meta', 'k').available).toBe(true);
  });

  it('listReviews returns [] without calling out when unconfigured', async () => {
    const c = new HttpAntiCheatClient(null, 'k');
    expect(await c.listReviews()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listReviews builds the query string from opts and returns the reviews array', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { reviews: [{ id: '1' }] } });
    const c = new HttpAntiCheatClient('http://meta', 'k');
    const rows = await c.listReviews({ accountId: 'a1', status: 'open', limit: 5 });
    expect(rows).toEqual([{ id: '1' }]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://meta/internal/anticheat/reviews?accountId=a1&status=open&limit=5');
  });

  it('listReviews degrades to [] on failure or empty body', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpAntiCheatClient('http://meta', 'k').listReviews()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpAntiCheatClient('http://meta', 'k').listReviews()).toEqual([]);
  });

  it('resolveReview posts the resolution and reports {ok:false} when unconfigured', async () => {
    expect(await new HttpAntiCheatClient(null, 'k').resolveReview('r1', 'dismissed', 'admin')).toEqual({ ok: false });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    const res = await new HttpAntiCheatClient('http://meta', 'k').resolveReview('r1', 'banned', 'admin');
    expect(res).toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://meta/internal/anticheat/reviews/r1/resolve');
    expect(opts).toMatchObject({ method: 'POST', body: { resolution: 'banned', resolvedBy: 'admin' } });
  });
});

describe('HttpMismatchClient', () => {
  it('listMismatches degrades to [] when unconfigured, on failure, and maps a good response', async () => {
    expect(await new HttpMismatchClient(null, 'k').listMismatches()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null });
    expect(await new HttpMismatchClient('http://meta', 'k').listMismatches()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { matches: [{ roomId: 'r1' }] } });
    expect(await new HttpMismatchClient('http://meta', 'k').listMismatches()).toEqual([{ roomId: 'r1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/mismatches');
  });
});

describe('HttpPvpCardStatsClient', () => {
  it('omits query params that are absent and includes those given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { cards: [] } });
    await new HttpPvpCardStatsClient('http://meta', 'k').listPvpCardStats({});
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/pvp-card-stats');

    await new HttpPvpCardStatsClient('http://meta', 'k').listPvpCardStats({ mode: 'ranked', since: '2026-01-01' });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/pvp-card-stats?mode=ranked&since=2026-01-01');
  });

  it('degrades to [] when unconfigured or on failure', async () => {
    expect(await new HttpPvpCardStatsClient(null, 'k').listPvpCardStats({})).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpPvpCardStatsClient('http://meta', 'k').listPvpCardStats({})).toEqual([]);
  });
});

describe('HttpSuspiciousPveClient', () => {
  it('listSuspiciousPve maps flags.pveWarnings/banned into flat fields, defaulting missing flags', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: { accounts: [{ _id: 'a1', createdAt: 1, flags: { pveWarnings: 3, banned: true } }, { _id: 'a2', createdAt: 2 }] },
    });
    const rows = await new HttpSuspiciousPveClient('http://meta', 'k').listSuspiciousPve();
    expect(rows).toEqual([
      { _id: 'a1', displayName: undefined, publicId: undefined, pveWarnings: 3, banned: true, createdAt: 1 },
      { _id: 'a2', displayName: undefined, publicId: undefined, pveWarnings: 0, banned: false, createdAt: 2 },
    ]);
  });

  it('listSuspiciousPve degrades to [] when unconfigured or on failure', async () => {
    expect(await new HttpSuspiciousPveClient(null, 'k').listSuspiciousPve()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpSuspiciousPveClient('http://meta', 'k').listSuspiciousPve()).toEqual([]);
  });

  it('banAccount/unbanAccount report {ok:false} unconfigured, and post to the right endpoint otherwise', async () => {
    expect(await new HttpSuspiciousPveClient(null, 'k').banAccount('a1')).toEqual({ ok: false });
    expect(await new HttpSuspiciousPveClient(null, 'k').unbanAccount('a1')).toEqual({ ok: false });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    expect(await new HttpSuspiciousPveClient('http://meta', 'k').banAccount('a1')).toEqual({ ok: true });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/accounts/a1/ban');
    expect(await new HttpSuspiciousPveClient('http://meta', 'k').unbanAccount('a1')).toEqual({ ok: true });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/accounts/a1/unban');
  });
});

describe('HttpFeedbackClient', () => {
  it('listFeedback degrades to [] unconfigured/on failure and maps a good response', async () => {
    expect(await new HttpFeedbackClient(null, 'k').listFeedback()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 503, body: null });
    expect(await new HttpFeedbackClient('http://meta', 'k').listFeedback()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { feedback: [{ _id: 'f1' }] } });
    expect(await new HttpFeedbackClient('http://meta', 'k').listFeedback({ limit: 10 })).toEqual([{ _id: 'f1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://meta/internal/feedback?limit=10');
  });
});

describe('HttpAppealsClient', () => {
  it('listAppeals degrades to [] unconfigured/on failure and maps a good response', async () => {
    expect(await new HttpAppealsClient(null, 'k').listAppeals()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpAppealsClient('http://meta', 'k').listAppeals()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { appeals: [{ _id: 'ap1' }] } });
    expect(await new HttpAppealsClient('http://meta', 'k').listAppeals({ status: 'open' })).toEqual([{ _id: 'ap1' }]);
  });

  it('resolveAppeal includes note only when given, and reports {ok:false} unconfigured', async () => {
    expect(await new HttpAppealsClient(null, 'k').resolveAppeal('ap1', 'approved', 'admin')).toEqual({ ok: false });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    await new HttpAppealsClient('http://meta', 'k').resolveAppeal('ap1', 'denied', 'admin');
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: { resolution: 'denied', resolvedBy: 'admin' } });
    await new HttpAppealsClient('http://meta', 'k').resolveAppeal('ap1', 'approved', 'admin', 'reviewed manually');
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: { resolution: 'approved', resolvedBy: 'admin', note: 'reviewed manually' } });
  });
});

describe('HttpReportsClient', () => {
  it('listReports degrades to [] unconfigured/on failure and maps a good response', async () => {
    expect(await new HttpReportsClient(null, 'k').listReports()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpReportsClient('http://social', 'k').listReports()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { reports: [{ _id: 'rp1' }] } });
    expect(await new HttpReportsClient('http://social', 'k').listReports({ status: 'open', limit: 20 })).toEqual([{ _id: 'rp1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://social/internal/reports?status=open&limit=20');
  });

  it('resolveReport reports {ok:false} unconfigured and posts the resolution otherwise', async () => {
    expect(await new HttpReportsClient(null, 'k').resolveReport('rp1', 'upheld', 'admin')).toEqual({ ok: false });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    expect(await new HttpReportsClient('http://social', 'k').resolveReport('rp1', 'dismissed', 'admin')).toEqual({ ok: true });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://social/internal/reports/rp1/resolve');
  });
});

describe('HttpEnforcementClient', () => {
  it('applyPenalty reports {ok:false} unconfigured or on failure', async () => {
    expect(await new HttpEnforcementClient(null, 'k').applyPenalty('a1', -5)).toEqual({ ok: false });
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpEnforcementClient('http://meta', 'k').applyPenalty('a1', -5)).toEqual({ ok: false });
  });

  it('applyPenalty strips the ok flag out of the result payload on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, reputationScore: 42, action: 'warn' } });
    const res = await new HttpEnforcementClient('http://meta', 'k').applyPenalty('a1', -5);
    expect(res).toEqual({ ok: true, result: { reputationScore: 42, action: 'warn' } });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: { delta: -5 } });
  });
});
