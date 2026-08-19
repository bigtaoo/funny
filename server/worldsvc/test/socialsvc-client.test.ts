// HttpWorldSocialsvcClient / nullWorldSocialsvcClient unit tests: fixture node:http server (real
// socket, no mocking of @nw/shared), asserting both (a) the request worldsvc actually sends
// (method/path/body — especially encodeURIComponent'd path params and POST body shape) and (b)
// how each method degrades on a non-2xx response or a null baseUrl (worldsvc's socialsvc mirror
// is best-effort throughout — see file header of ../src/socialsvcClient.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpWorldSocialsvcClient,
  nullWorldSocialsvcClient,
  type FamilyMembership,
  type FamilySummary,
} from '../src/socialsvcClient';

const KEY = 'k-internal';

interface RecordedReq {
  method: string;
  url: string;
  body: unknown;
  headers: IncomingMessage['headers'];
}

let server: Server;
let base: string;
let lastReq: RecordedReq | null = null;
let requestCount = 0;
let nextStatus = 200;
let nextBody: unknown = { data: {} };

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
      lastReq = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
        headers: req.headers,
      };
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
  nextBody = { data: {} };
  lastReq = null;
  requestCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpWorldSocialsvcClient.available', () => {
  it('true when baseUrl is set, false when null', () => {
    expect(new HttpWorldSocialsvcClient(base, KEY).available).toBe(true);
    expect(new HttpWorldSocialsvcClient(null, KEY).available).toBe(false);
  });
});

describe('HttpWorldSocialsvcClient.getFamilyId', () => {
  it('success → returns data.familyId, hits GET /internal/family/by-account/:accountId (encoded)', async () => {
    nextBody = { data: { familyId: 'fam-1' } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamilyId('acc/1 x')).resolves.toBe('fam-1');
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe(`/internal/family/by-account/${encodeURIComponent('acc/1 x')}`);
    expect(lastReq?.headers['x-internal-key']).toBe(KEY);
  });

  it('data.familyId absent → resolves null', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamilyId('acc1')).resolves.toBeNull();
  });

  it('non-2xx → resolves null', async () => {
    nextStatus = 500;
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamilyId('acc1')).resolves.toBeNull();
  });

  it('baseUrl null → resolves null without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.getFamilyId('acc1')).resolves.toBeNull();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.getMember', () => {
  const membership: FamilyMembership = {
    familyId: 'fam-1',
    role: 'leader',
    leaderId: 'acc1',
    name: 'Fam',
    tag: 'TAG',
    memberCount: 3,
    sectId: 'sect-1',
    emblemKey: 'emblem_crown',
    emblemColor: 0xff0000,
  };

  it('success → returns data.member, hits GET /internal/family/member/:accountId (encoded)', async () => {
    nextBody = { data: { member: membership } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getMember('acc 1')).resolves.toEqual(membership);
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe(`/internal/family/member/${encodeURIComponent('acc 1')}`);
  });

  it('not in a family (data.member absent) → resolves null', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getMember('acc1')).resolves.toBeNull();
  });

  it('non-2xx → resolves null', async () => {
    nextStatus = 404;
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getMember('acc1')).resolves.toBeNull();
  });

  it('baseUrl null → resolves null without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.getMember('acc1')).resolves.toBeNull();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.getFamiliesByIds', () => {
  const fam: FamilySummary = {
    familyId: 'fam-1',
    name: 'Fam',
    tag: 'TAG',
    leaderId: 'acc1',
    memberCount: 3,
    prosperity: 42,
  };

  it('success → POST /internal/family/batch with { familyIds } body, returns data.families', async () => {
    nextBody = { data: { families: [fam] } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesByIds(['fam-1', 'fam-2'])).resolves.toEqual([fam]);
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/family/batch');
    expect(lastReq?.body).toEqual({ familyIds: ['fam-1', 'fam-2'] });
  });

  it('empty familyIds → resolves [] without a request', async () => {
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesByIds([])).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });

  it('success but data.families absent → resolves []', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesByIds(['fam-1'])).resolves.toEqual([]);
  });

  it('non-2xx → resolves []', async () => {
    nextStatus = 500;
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesByIds(['fam-1'])).resolves.toEqual([]);
  });

  it('baseUrl null → resolves [] without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.getFamiliesByIds(['fam-1'])).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.getFamiliesBySect', () => {
  const fam: FamilySummary = {
    familyId: 'fam-1',
    name: 'Fam',
    tag: 'TAG',
    leaderId: 'acc1',
    memberCount: 3,
    prosperity: 42,
    sectId: 'sect-1',
  };

  it('success → GET /internal/family/by-sect/:sectId (encoded), returns data.families', async () => {
    nextBody = { data: { families: [fam] } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesBySect('sect/1')).resolves.toEqual([fam]);
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe(`/internal/family/by-sect/${encodeURIComponent('sect/1')}`);
  });

  it('success but data.families absent → resolves []', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesBySect('sect-1')).resolves.toEqual([]);
  });

  it('non-2xx → resolves []', async () => {
    nextStatus = 500;
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.getFamiliesBySect('sect-1')).resolves.toEqual([]);
  });

  it('baseUrl null → resolves [] without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.getFamiliesBySect('sect-1')).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.setSect', () => {
  it('success → POST /internal/family/:id/sect with { sectId, sectName } body, no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.setSect('fam 1', 'sect-1', 'Sect Name')).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe(`/internal/family/${encodeURIComponent('fam 1')}/sect`);
    expect(lastReq?.body).toEqual({ sectId: 'sect-1', sectName: 'Sect Name' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('clearing sect (sectId null, sectName omitted) sends { sectId: null }', async () => {
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await c.setSect('fam1', null);
    expect(lastReq?.body).toEqual({ sectId: null });
  });

  it('non-2xx → logs via console.error with familyId/sectId/status context, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.setSect('fam1', 'sect-1')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [msg, ctx] = errSpy.mock.calls[0]!;
    expect(msg).toBe('[worldsvc] socialsvc.setSect failed');
    expect(ctx).toMatchObject({ familyId: 'fam1', sectId: 'sect-1', status: 500 });
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.setSect('fam1', 'sect-1')).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.bumpActivity', () => {
  it('success → POST /internal/family/activity with { familyId, delta } body, no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.bumpActivity('fam1', 5)).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/family/activity');
    expect(lastReq?.body).toEqual({ familyId: 'fam1', delta: 5 });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('non-2xx → logs via console.error, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.bumpActivity('fam1', 5)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe('[worldsvc] socialsvc.bumpActivity failed');
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.bumpActivity('fam1', 5)).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.refreshProsperity', () => {
  it('success → POST /internal/family/:id/prosperity/refresh with { territoryCount }, returns data.prosperity', async () => {
    nextBody = { data: { prosperity: 77 } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.refreshProsperity('fam 1', 12)).resolves.toBe(77);
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe(`/internal/family/${encodeURIComponent('fam 1')}/prosperity/refresh`);
    expect(lastReq?.body).toEqual({ territoryCount: 12 });
  });

  it('success but data.prosperity absent → resolves 0', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.refreshProsperity('fam1', 12)).resolves.toBe(0);
  });

  it('non-2xx → resolves 0', async () => {
    nextStatus = 500;
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.refreshProsperity('fam1', 12)).resolves.toBe(0);
  });

  it('baseUrl null → resolves 0 without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.refreshProsperity('fam1', 12)).resolves.toBe(0);
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.bumpActivityAndProsperity', () => {
  it('success → POST /internal/family/:id/activity-and-prosperity with { delta, territoryCount }, returns data.prosperity', async () => {
    nextBody = { data: { prosperity: 88 } };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.bumpActivityAndProsperity('fam 1', 3, 9)).resolves.toBe(88);
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe(`/internal/family/${encodeURIComponent('fam 1')}/activity-and-prosperity`);
    expect(lastReq?.body).toEqual({ delta: 3, territoryCount: 9 });
  });

  it('success but data.prosperity absent → resolves 0', async () => {
    nextBody = { data: {} };
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.bumpActivityAndProsperity('fam1', 3, 9)).resolves.toBe(0);
  });

  it('non-2xx → logs via console.error and resolves 0', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.bumpActivityAndProsperity('fam1', 3, 9)).resolves.toBe(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe('[worldsvc] socialsvc.bumpActivityAndProsperity failed');
  });

  it('baseUrl null → resolves 0 without a request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.bumpActivityAndProsperity('fam1', 3, 9)).resolves.toBe(0);
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.resetSlgState', () => {
  it('success → POST /internal/family/:id/slg-reset, no console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.resetSlgState('fam 1')).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe(`/internal/family/${encodeURIComponent('fam 1')}/slg-reset`);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('non-2xx → logs via console.error, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.resetSlgState('fam1')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toBe('[worldsvc] socialsvc.resetSlgState failed');
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.resetSlgState('fam1')).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('HttpWorldSocialsvcClient.push', () => {
  it('success without targets → POST /internal/push with { channel, event, payload } (no targets key)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.push({ kind: 'family', familyId: 'fam1' }, 'family_msg', { hello: 1 })).resolves.toBeUndefined();
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/push');
    expect(lastReq?.body).toEqual({ channel: { kind: 'family', familyId: 'fam1' }, event: 'family_msg', payload: { hello: 1 } });
    expect(lastReq?.body).not.toHaveProperty('targets');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('success with targets → body includes targets list', async () => {
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await c.push({ kind: 'sect', sectId: 'sect1' }, 'sect_msg', { body: 'hi' }, ['acc1', 'acc2']);
    expect(lastReq?.body).toEqual({
      channel: { kind: 'sect', sectId: 'sect1' },
      event: 'sect_msg',
      payload: { body: 'hi' },
      targets: ['acc1', 'acc2'],
    });
  });

  it('non-2xx → logs via console.error with event/status context, does not throw', async () => {
    nextStatus = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await expect(c.push({ kind: 'world', worldId: 'w1' }, 'nation_msg', {})).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [msg, ctx] = errSpy.mock.calls[0]!;
    expect(msg).toBe('[worldsvc] socialsvc.push failed');
    expect(ctx).toMatchObject({ event: 'nation_msg', status: 500 });
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldSocialsvcClient(null, KEY);
    await expect(c.push({ kind: 'account', accountId: 'acc1' }, 'evt', {})).resolves.toBeUndefined();
    expect(requestCount).toBe(0);
  });
});

describe('nullWorldSocialsvcClient', () => {
  it('available is false', () => {
    expect(nullWorldSocialsvcClient.available).toBe(false);
  });

  it('every method is a no-op returning its documented default', async () => {
    await expect(nullWorldSocialsvcClient.getFamilyId('a')).resolves.toBeNull();
    await expect(nullWorldSocialsvcClient.getMember('a')).resolves.toBeNull();
    await expect(nullWorldSocialsvcClient.getFamiliesByIds(['a'])).resolves.toEqual([]);
    await expect(nullWorldSocialsvcClient.getFamiliesBySect('s')).resolves.toEqual([]);
    await expect(nullWorldSocialsvcClient.setSect('f', 's')).resolves.toBeUndefined();
    await expect(nullWorldSocialsvcClient.bumpActivity('f', 1)).resolves.toBeUndefined();
    await expect(nullWorldSocialsvcClient.refreshProsperity('f', 1)).resolves.toBe(0);
    await expect(nullWorldSocialsvcClient.bumpActivityAndProsperity('f', 1, 1)).resolves.toBe(0);
    await expect(nullWorldSocialsvcClient.resetSlgState('f')).resolves.toBeUndefined();
    await expect(nullWorldSocialsvcClient.push({ kind: 'account', accountId: 'a' }, 'evt', {})).resolves.toBeUndefined();
  });
});
