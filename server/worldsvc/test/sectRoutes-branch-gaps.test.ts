// Branch-coverage backfill for src/httpApi/sectRoutes.ts (73.5% branch at 100% line): every handler in
// the chain validates its JSON body with `typeof body.x === 'string' ? body.x : null` and then early-returns
// `sendErr(BAD_REQUEST)`, and test/sectHttp.e2e.test.ts only ever sends well-formed bodies — so the whole
// missing-field half of the file was unreached while every line still counted as covered.
//
// Unit test, not e2e: `handleSectRoutes(ctx: RouteCtx)` receives every dependency in one context object, so
// it runs directly against a hand-built `req` (a Readable carrying the JSON body — that is all `readJson`
// consumes) and a `res` that records writeHead/end, with a `vi.fn()` stub per SectService method. No HTTP
// listener and no Mongo. Real @nw/shared helpers (ErrorCode/ERROR_HTTP_STATUS/ok/regionFromAcceptLanguage)
// are used unmocked so the expected status/code/region come from the same source the handler does.
//
// Each validation case asserts all three observable effects: the HTTP status, the ErrorCode in the body, and
// that the SectService method was never called (a handler that answered 400 but still fired the write would
// pass a status-only assertion).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCode, ERROR_HTTP_STATUS, ok, regionFromAcceptLanguage } from '@nw/shared';
import { handleSectRoutes } from '../src/httpApi/sectRoutes';
import type { RouteCtx } from '../src/httpApi/helpers';
import type { SectService } from '../src/sectService';

const ACCOUNT = 'acc-1';
const BAD_REQUEST_STATUS = ERROR_HTTP_STATUS[ErrorCode.BAD_REQUEST] ?? 400;

/** Every SectService method reachable from this route chain, each a fresh spy per test. */
function stubSectSvc() {
  return {
    listSects: vi.fn(async () => []),
    getSect: vi.fn(async () => null),
    createSect: vi.fn(async () => ({ sectId: 'sect:w1:SKY' })),
    joinSect: vi.fn(async () => undefined),
    leaveSect: vi.fn(async () => undefined),
    dissolveSect: vi.fn(async () => undefined),
    allySect: vi.fn(async () => undefined),
    unallySect: vi.fn(async () => undefined),
    voteRemoveLeader: vi.fn(async () => ({ votes: 1 })),
    setEmblem: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: 'msg-1' })),
    getChannel: vi.fn(async () => []),
  };
}

type SectSvcStub = ReturnType<typeof stubSectSvc>;

interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
}

function fakeReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = headers;
  return req;
}

function fakeRes(rec: Recorded): ServerResponse {
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      rec.status = status;
      rec.headers = headers;
      return res;
    },
    end(payload: string) {
      rec.body = JSON.parse(payload);
      rec.ended = true;
    },
  };
  return res as unknown as ServerResponse;
}

interface CallOpts {
  method: string;
  path: string;
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
  sectSvc: SectSvcStub;
}

async function call(opts: CallOpts): Promise<{ handled: boolean; rec: Recorded }> {
  const rec: Recorded = { status: 0, headers: {}, body: undefined, ended: false };
  const ctx = {
    req: fakeReq(opts.body ?? {}, opts.headers ?? {}),
    res: fakeRes(rec),
    method: opts.method,
    path: opts.path,
    q: new URLSearchParams(opts.query ?? ''),
    accountId: ACCOUNT,
    clientPlatform: 'web',
    sectSvc: opts.sectSvc as unknown as SectService,
  } as unknown as RouteCtx;
  const handled = await handleSectRoutes(ctx);
  return { handled, rec };
}

function expectBadRequest(rec: Recorded): void {
  expect(rec.ended).toBe(true);
  expect(rec.status).toBe(BAD_REQUEST_STATUS);
  expect(rec.body).toMatchObject({ ok: false, error: { code: ErrorCode.BAD_REQUEST } });
}

/** Asserts nothing on the service was touched — a 400 that still fired the write would be a real bug. */
function expectNoWrites(sectSvc: SectSvcStub): void {
  for (const fn of Object.values(sectSvc)) expect(fn).not.toHaveBeenCalled();
}

let sectSvc: SectSvcStub;
beforeEach(() => {
  sectSvc = stubSectSvc();
});

describe('handleSectRoutes — query-parameter validation', () => {
  it('GET /sect/list without worldId → BAD_REQUEST, listSects never called', async () => {
    const { handled, rec } = await call({ method: 'GET', path: '/sect/list', sectSvc });
    expect(handled).toBe(true);
    expectBadRequest(rec);
    expectNoWrites(sectSvc);
  });

  it('GET /sect/list with worldId → 200 and the worldId is forwarded verbatim', async () => {
    const { handled, rec } = await call({ method: 'GET', path: '/sect/list', query: 'worldId=w1', sectSvc });
    expect(handled).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual(ok([]));
    expect(sectSvc.listSects).toHaveBeenCalledWith('w1');
  });

  it('GET /sect/channel without worldId → BAD_REQUEST, getChannel never called', async () => {
    const { handled, rec } = await call({ method: 'GET', path: '/sect/channel', sectSvc });
    expect(handled).toBe(true);
    expectBadRequest(rec);
    expectNoWrites(sectSvc);
  });

  it('GET /sect/channel passes `before` as a number and the default limit when neither is given', async () => {
    const { rec } = await call({ method: 'GET', path: '/sect/channel', query: 'worldId=w1', sectSvc });
    expect(rec.status).toBe(200);
    expect(sectSvc.getChannel).toHaveBeenCalledWith('w1', ACCOUNT, undefined, 30);
  });

  it('GET /sect/channel with before + limit forwards both parsed', async () => {
    await call({ method: 'GET', path: '/sect/channel', query: 'worldId=w1&before=1700&limit=5', sectSvc });
    expect(sectSvc.getChannel).toHaveBeenCalledWith('w1', ACCOUNT, 1700, 5);
  });

  it('GET /sect/channel with a non-numeric limit falls back to the default 30', async () => {
    await call({ method: 'GET', path: '/sect/channel', query: 'worldId=w1&limit=abc', sectSvc });
    expect(sectSvc.getChannel).toHaveBeenCalledWith('w1', ACCOUNT, undefined, 30);
  });
});

describe('handleSectRoutes — POST body validation', () => {
  // [route, service method, body that is missing exactly one required field]
  const cases: Array<[string, keyof SectSvcStub, Record<string, unknown>, string]> = [
    ['/sect/create', 'createSect', { name: 'Sky', tag: 'SKY' }, 'no worldId'],
    ['/sect/create', 'createSect', { worldId: 'w1', tag: 'SKY' }, 'no name'],
    ['/sect/create', 'createSect', { worldId: 'w1', name: 'Sky' }, 'no tag'],
    ['/sect/create', 'createSect', { worldId: 'w1', name: 'Sky', tag: 7 }, 'non-string tag'],
    ['/sect/join', 'joinSect', { sectId: 'sect:w1:SKY' }, 'no worldId'],
    ['/sect/join', 'joinSect', { worldId: 'w1' }, 'no sectId'],
    ['/sect/leave', 'leaveSect', {}, 'no worldId'],
    ['/sect/leave', 'leaveSect', { worldId: 42 }, 'non-string worldId'],
    ['/sect/dissolve', 'dissolveSect', {}, 'no worldId'],
    ['/sect/ally', 'allySect', { targetSectId: 'sect:w1:SEA' }, 'no worldId'],
    ['/sect/ally', 'allySect', { worldId: 'w1' }, 'no targetSectId'],
    ['/sect/unally', 'unallySect', { targetSectId: 'sect:w1:SEA' }, 'no worldId'],
    ['/sect/unally', 'unallySect', { worldId: 'w1' }, 'no targetSectId'],
    ['/sect/vote-remove-leader', 'voteRemoveLeader', { nomineeFamilyId: 'fam1' }, 'no worldId'],
    ['/sect/vote-remove-leader', 'voteRemoveLeader', { worldId: 'w1' }, 'no nomineeFamilyId'],
    ['/sect/emblem', 'setEmblem', { emblemKey: 'emblem_bear', emblemColor: 3 }, 'no worldId'],
    ['/sect/emblem', 'setEmblem', { worldId: 'w1', emblemColor: 3 }, 'no emblemKey'],
    ['/sect/emblem', 'setEmblem', { worldId: 'w1', emblemKey: 'emblem_bear' }, 'no emblemColor'],
    ['/sect/emblem', 'setEmblem', { worldId: 'w1', emblemKey: 'emblem_bear', emblemColor: '3' }, 'string emblemColor'],
    ['/sect/message', 'sendMessage', { body: 'hi' }, 'no worldId'],
    ['/sect/message', 'sendMessage', { worldId: 'w1' }, 'no body'],
    ['/sect/message', 'sendMessage', { worldId: 'w1', body: 123 }, 'non-string body'],
  ];

  for (const [path, method, body, why] of cases) {
    it(`POST ${path} with ${why} → BAD_REQUEST, ${String(method)} never called`, async () => {
      const { handled, rec } = await call({ method: 'POST', path, body, sectSvc });
      expect(handled).toBe(true);
      expectBadRequest(rec);
      expectNoWrites(sectSvc);
    });
  }
});

describe('handleSectRoutes — accepted bodies', () => {
  it('POST /sect/create derives the chat region from Accept-Language', async () => {
    const headers = { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' };
    const { rec } = await call({
      method: 'POST', path: '/sect/create', body: { worldId: 'w1', name: 'Sky', tag: 'SKY' }, headers, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(sectSvc.createSect).toHaveBeenCalledWith(
      'w1', ACCOUNT, 'Sky', 'SKY', 'web', regionFromAcceptLanguage(headers['accept-language']),
    );
  });

  it('POST /sect/create with no Accept-Language header still resolves a region (global)', async () => {
    await call({ method: 'POST', path: '/sect/create', body: { worldId: 'w1', name: 'Sky', tag: 'SKY' }, sectSvc });
    expect(sectSvc.createSect).toHaveBeenCalledWith('w1', ACCOUNT, 'Sky', 'SKY', 'web', regionFromAcceptLanguage(undefined));
  });

  it('POST /sect/emblem accepts emblemColor 0 — the guard is `== null`, not truthiness', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/emblem', body: { worldId: 'w1', emblemKey: 'emblem_bear', emblemColor: 0 }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(sectSvc.setEmblem).toHaveBeenCalledWith('w1', ACCOUNT, 'emblem_bear', 0);
  });

  it('POST /sect/message with a non-string senderName falls back to the accountId', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/message', body: { worldId: 'w1', body: 'hello', senderName: 42 }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(sectSvc.sendMessage).toHaveBeenCalledWith('w1', ACCOUNT, ACCOUNT, 'hello', regionFromAcceptLanguage(undefined));
  });

  it('POST /sect/message keeps a sanitized client senderName when one is supplied', async () => {
    await call({
      method: 'POST', path: '/sect/message', body: { worldId: 'w1', body: 'hello', senderName: ' Alice ' }, sectSvc,
    });
    expect(sectSvc.sendMessage).toHaveBeenCalledWith('w1', ACCOUNT, 'Alice', 'hello', regionFromAcceptLanguage(undefined));
  });

  it('POST /sect/leave passes worldId + accountId and answers ok({})', async () => {
    const { rec } = await call({ method: 'POST', path: '/sect/leave', body: { worldId: 'w1' }, sectSvc });
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual(ok({}));
    expect(sectSvc.leaveSect).toHaveBeenCalledWith('w1', ACCOUNT);
  });

  it('POST /sect/dissolve passes worldId + accountId and answers ok({})', async () => {
    const { rec } = await call({ method: 'POST', path: '/sect/dissolve', body: { worldId: 'w1' }, sectSvc });
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual(ok({}));
    expect(sectSvc.dissolveSect).toHaveBeenCalledWith('w1', ACCOUNT);
  });

  it('POST /sect/ally forwards the target sect id', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/ally', body: { worldId: 'w1', targetSectId: 'sect:w1:SEA' }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(sectSvc.allySect).toHaveBeenCalledWith('w1', ACCOUNT, 'sect:w1:SEA');
    expect(sectSvc.unallySect).not.toHaveBeenCalled();
  });

  it('POST /sect/unally forwards the target sect id', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/unally', body: { worldId: 'w1', targetSectId: 'sect:w1:SEA' }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(sectSvc.unallySect).toHaveBeenCalledWith('w1', ACCOUNT, 'sect:w1:SEA');
    expect(sectSvc.allySect).not.toHaveBeenCalled();
  });

  it('POST /sect/vote-remove-leader returns the tally from the service', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/vote-remove-leader', body: { worldId: 'w1', nomineeFamilyId: 'fam1' }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual(ok({ votes: 1 }));
    expect(sectSvc.voteRemoveLeader).toHaveBeenCalledWith('w1', ACCOUNT, 'fam1');
  });

  it('POST /sect/join with both fields calls joinSect and answers 200', async () => {
    const { rec } = await call({
      method: 'POST', path: '/sect/join', body: { worldId: 'w1', sectId: 'sect:w1:SKY' }, sectSvc,
    });
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual(ok({}));
    expect(sectSvc.joinSect).toHaveBeenCalledWith('w1', ACCOUNT, 'sect:w1:SKY');
  });
});

describe('handleSectRoutes — chain fall-through', () => {
  it('returns false and writes nothing for a path this group does not own', async () => {
    const { handled, rec } = await call({ method: 'GET', path: '/world/map', sectSvc });
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expectNoWrites(sectSvc);
  });

  it('GET /sect/:id resolves the id but GET /sect/list and /sect/channel keep their own handlers', async () => {
    const { handled, rec } = await call({ method: 'GET', path: '/sect/sect%3Aw1%3ASKY', sectSvc });
    expect(handled).toBe(true);
    expect(rec.status).toBe(200);
    expect(sectSvc.getSect).toHaveBeenCalledWith('sect:w1:SKY');
  });

  it('POST /sect/list is not matched by the GET-only list handler', async () => {
    const { handled } = await call({ method: 'POST', path: '/sect/list', sectSvc });
    expect(handled).toBe(false);
    expectNoWrites(sectSvc);
  });
});
