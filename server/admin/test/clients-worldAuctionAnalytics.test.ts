// See clients-lookupAndQueue.test.ts header for why this file exists (2026-08-14 coverage backlog).
// This group: world (largest client — season lifecycle + map templates, all via a shared `request()`
// that throws on failure), auction (anomaly scan + listing query, throws), analytics (discriminated
// query-result mapping over ~15 report types, degrades to {}).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return { ...actual, fetchInternalJson: vi.fn() };
});

import { fetchInternalJson } from '@nw/shared';
import { HttpWorldClient } from '../src/clients/world';
import { HttpAuctionClient } from '../src/clients/auction';
import { HttpAnalyticsClient } from '../src/clients/analytics';

const fetchMock = fetchInternalJson as unknown as Mock;

afterEach(() => {
  fetchMock.mockReset();
});

describe('HttpWorldClient', () => {
  it('listWorlds returns [] unconfigured (still no throw — the one read that predates request())', async () => {
    expect(await new HttpWorldClient(null, 'k').listWorlds()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listWorlds throws on failure and maps a good response, defaulting missing data to []', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'boom' });
    await expect(new HttpWorldClient('http://world', 'k').listWorlds()).rejects.toThrow('listWorlds failed');
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpWorldClient('http://world', 'k').listWorlds()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: [{ worldId: 'w1' }] } });
    expect(await new HttpWorldClient('http://world', 'k').listWorlds()).toEqual([{ worldId: 'w1' }]);
  });

  it("request() throws 'not configured' when baseUrl is null (season ops)", async () => {
    await expect(new HttpWorldClient(null, 'k').openWorld('w1', 1, 0, 100)).rejects.toThrow('worldsvc not configured');
  });

  it('request() throws using body.error.message, then falls back to status/network-error text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, body: { error: { message: 'bad shard' } } });
    await expect(new HttpWorldClient('http://world', 'k').openWorld('w1', 1, 0, 100)).rejects.toThrow('bad shard');

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: false } });
    await expect(new HttpWorldClient('http://world', 'k').settleWorld('w1')).rejects.toThrow('settle failed');

    fetchMock.mockResolvedValue({ ok: false, status: 0, body: null, error: 'timeout' });
    await expect(new HttpWorldClient('http://world', 'k').resetWorld('w1')).rejects.toThrow('timeout');
  });

  it('season ops post to the right path with a long timeout and resolve on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: undefined } });
    await new HttpWorldClient('http://world', 'k').openWorld('w1', 2, 0, 500);
    expect(fetchMock.mock.calls.at(-1)).toEqual([
      'http://world/admin/world/open',
      expect.objectContaining({ method: 'POST', body: { worldId: 'w1', season: 2, shard: 0, capacity: 500 }, timeoutMs: 120000 }),
    ]);
    await new HttpWorldClient('http://world', 'k').closeWorld('w1');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://world/admin/world/close');

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: { moved: 3, failed: [] } } });
    expect(await new HttpWorldClient('http://world', 'k').mergeWorld('w1', 'w2')).toEqual({ moved: 3, failed: [] });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: { shardCount: 2, worldIds: ['w1', 'w2'], allocatedFamilies: 10 } } });
    expect(await new HttpWorldClient('http://world', 'k').allocateNextSeason(3)).toEqual({ shardCount: 2, worldIds: ['w1', 'w2'], allocatedFamilies: 10 });
    expect(await new HttpWorldClient('http://world', 'k').allocateNextSeason(3, 999)).toBeDefined();
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: { season: 3, capacity: 999 } });
  });

  it('map template CRUD: GET/PUT/DELETE variants + empty-list defaults when unconfigured', async () => {
    expect(await new HttpWorldClient(null, 'k').listMapTemplates()).toEqual([]);
    expect(await new HttpWorldClient(null, 'k').getMapTemplateTiles('t1', 0, 0, 10, 10)).toEqual([]);

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: [{ id: 't1' }] } });
    expect(await new HttpWorldClient('http://world', 'k').listMapTemplates()).toEqual([{ id: 't1' }]);
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://world/admin/world/map-templates', expect.objectContaining({ method: 'GET' })]);

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: { id: 't2' } } });
    expect(await new HttpWorldClient('http://world', 'k').generateMapTemplate('t2', 32, 32)).toEqual({ id: 't2' });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST', body: { templateId: 't2', width: 32, height: 32 } });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: [{ x: 0, y: 0 }] } });
    await new HttpWorldClient('http://world', 'k').getMapTemplateTiles('t1', 1, 2, 3, 4);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://world/admin/world/map-templates/t1/tiles?x=1&y=2&w=3&h=4');

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true, data: { updated: 5 } } });
    expect(await new HttpWorldClient('http://world', 'k').saveMapTemplateTiles('t1', [])).toEqual({ updated: 5 });
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://world/admin/world/map-templates/t1/tiles', expect.objectContaining({ method: 'PUT' })]);

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    await new HttpWorldClient('http://world', 'k').activateMapTemplate('t1');
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://world/admin/world/map-templates/t1/activate', expect.objectContaining({ method: 'POST', body: {} })]);
    await new HttpWorldClient('http://world', 'k').deleteMapTemplate('t1');
    expect(fetchMock.mock.calls.at(-1)).toEqual(['http://world/admin/world/map-templates/t1', expect.objectContaining({ method: 'DELETE' })]);
  });
});

describe('HttpAuctionClient', () => {
  it('scanAnomalies returns [] unconfigured, throws on failure, and maps a good response', async () => {
    expect(await new HttpAuctionClient(null, 'k').scanAnomalies()).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(new HttpAuctionClient('http://auction', 'k').scanAnomalies()).rejects.toThrow('scanAnomalies failed');
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: [{ id: 'anom1' }] } });
    expect(await new HttpAuctionClient('http://auction', 'k').scanAnomalies(3600)).toEqual([{ id: 'anom1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://auction/internal/audit/anomalies?windowSec=3600');
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpAuctionClient('http://auction', 'k').scanAnomalies()).toEqual([]);
  });

  it('queryListings returns [] unconfigured, throws on failure, builds the full query string, and maps a good response', async () => {
    expect(await new HttpAuctionClient(null, 'k').queryListings({})).toEqual([]);
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null, error: 'boom' });
    await expect(new HttpAuctionClient('http://auction', 'k').queryListings({})).rejects.toThrow('queryListings failed');

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: [{ id: 'l1' }] } });
    const rows = await new HttpAuctionClient('http://auction', 'k').queryListings({
      sellerId: 's1',
      itemType: 'card',
      status: 'open',
      itemName: 'dragon',
      limit: 20,
    });
    expect(rows).toEqual([{ id: 'l1' }]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://auction/internal/audit/listings?sellerId=s1&itemType=card&status=active&itemName=dragon&limit=20');
  });
});

describe('HttpAnalyticsClient', () => {
  it('query returns {} unconfigured (no call) and on failure/empty body/empty data', async () => {
    expect(await new HttpAnalyticsClient(null, 'k').query('dau', 7)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
    expect(await new HttpAnalyticsClient('http://an', 'k').query('dau', 7)).toEqual({});
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: {} });
    expect(await new HttpAnalyticsClient('http://an', 'k').query('dau', 7)).toEqual({});
  });

  it('query builds ?type&days(&platform) and dispatches every known report type by its `type` discriminant', async () => {
    const cases: [string, unknown, unknown][] = [
      ['event_counts', { counts: [{ date: 'd', event: 'e', count: 1 }] }, { event_counts: [{ date: 'd', event: 'e', count: 1 }] }],
      ['dau', { dau: [{ date: 'd', dau: 5 }] }, { dau: [{ date: 'd', dau: 5 }] }],
      ['funnel', { funnel: [] }, { funnel: [] }],
      ['region_dist', { regions: [{ locale: 'zh', devices: 1 }] }, { region_dist: [{ locale: 'zh', devices: 1 }] }],
      ['os_dist', { os_dist: [] }, { os_dist: [] }],
      ['login_hour', { login_hour: [] }, { login_hour: [] }],
      ['retention', { retention: [] }, { retention: [] }],
      ['first_session', { first_session: { cohort_size: 1, window_days: 7, funnel: [], actions: [] } }, { first_session: { cohort_size: 1, window_days: 7, funnel: [], actions: [] } }],
      ['level_funnel', { level_funnel: [] }, { level_funnel: [] }],
      ['tutorial_funnel', { tutorial_funnel: { cohort_size: 1, window_days: 7, funnel: [] } }, { tutorial_funnel: { cohort_size: 1, window_days: 7, funnel: [] } }],
      ['scene_funnel', { scene_funnel: { cohort_size: 1, window_days: 7, funnel: [] } }, { scene_funnel: { cohort_size: 1, window_days: 7, funnel: [] } }],
      ['browser_dist', { browser_dist: [] }, { browser_dist: [] }],
      ['device_type_dist', { device_type_dist: [] }, { device_type_dist: [] }],
      ['geo_dist', { geo_dist: [] }, { geo_dist: [] }],
      ['badge_dist', { badge_dist: [] }, { badge_dist: [] }],
      ['something_unmapped', {}, {}],
    ];
    for (const [type, payload, expected] of cases) {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: { type, ...(payload as object) } } });
      expect(await new HttpAnalyticsClient('http://an', 'k').query(type, 7)).toEqual(expected);
    }
  });

  it('defaults array fields to [] when the upstream omits them, and includes platform in the query string when given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: { type: 'dau' } } });
    expect(await new HttpAnalyticsClient('http://an', 'k').query('dau', 7)).toEqual({ dau: [] });

    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { data: { type: 'dau', dau: [] } } });
    await new HttpAnalyticsClient('http://an', 'k').query('dau', 30, 'ios');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://an/internal/query?type=dau&days=30&platform=ios');
  });
});
