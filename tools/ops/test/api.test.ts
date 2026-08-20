// src/api/** — the ops console's REST client: the transport half (base URL, Bearer token, the one
// fetch wrapper and its error mapping) and the endpoint surface stacked on it.
//
// This is a browser-facing module tested under `environment: 'node'`, so the three globals it needs —
// fetch, localStorage, location — are installed here. That is deliberate and is exactly the line
// test/pureLayerBoundary.test.ts draws: src/api/** may reach for those three and nothing else, which
// is what makes it testable without a DOM at all. Anything that needed `document` would belong in
// src/pages/**, which stays out of the coverage scope.
//
// The endpoint table below is the point of the file. Each method is one line of real behaviour —
// which verb, which path, what gets URL-encoded, which query params are OMITTED rather than sent
// empty, and which key the response is unwrapped from — and every one of those has been a bug
// somewhere. Testing them as data keeps the checks uniform instead of 60 near-identical `it`s.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api, ApiError } from '../src/api';

// ── globals the transport needs ──

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];
/** What the next fetch resolves to: a status plus a JSON body, or a thrown network error. */
let nextReply: { status?: number; json?: unknown; throws?: Error } = {};

const g = globalThis as unknown as {
  localStorage: FakeStorage;
  location: { hostname: string };
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<unknown>;
};

beforeEach(() => {
  g.localStorage = new FakeStorage();
  g.location = { hostname: 'localhost' };
  calls = [];
  nextReply = { json: { ok: true } };
  g.fetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (nextReply.throws) return Promise.reject(nextReply.throws);
    const status = nextReply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(nextReply.json ?? {}),
    });
  };
});

afterEach(() => {
  nextReply = {};
});

const only = (): Call => {
  expect(calls).toHaveLength(1);
  return calls[0]!;
};

describe('transport: base URL', () => {
  it('defaults to the local admin backend on localhost', () => {
    expect(new Api().baseUrl).toBe('http://localhost:18083');
    g.location.hostname = '127.0.0.1';
    expect(new Api().baseUrl).toBe('http://localhost:18083');
  });

  it('defaults to same-origin (empty prefix) anywhere else', () => {
    // Production is served by the ops Worker, which reverse-proxies /admin/* to the admin backend —
    // so the correct default there is a RELATIVE path, not a host.
    g.location.hostname = 'ops.notebookwars.example';
    expect(new Api().baseUrl).toBe('');
  });

  it('remembers an operator-entered base URL and strips one trailing slash', () => {
    const api = new Api();
    api.setBaseUrl('https://admin.example.com/');
    expect(api.baseUrl).toBe('https://admin.example.com');
    // A saved empty string must win over the hostname default: that is how someone pins same-origin
    // while developing against localhost.
    api.setBaseUrl('');
    expect(api.baseUrl).toBe('');
  });

  it('prefixes every request path with the base URL', async () => {
    const api = new Api();
    api.setBaseUrl('https://admin.example.com');
    nextReply = { json: { ok: true } };
    await api.me();
    expect(only().url).toBe('https://admin.example.com/admin/me');
  });
});

describe('transport: token', () => {
  it('picks up a token persisted by a previous session', () => {
    g.localStorage.setItem('nw_admin_token', 'stored-token');
    expect(new Api().hasToken).toBe(true);
  });

  it('sends no authorization header until a token exists', async () => {
    const api = new Api();
    expect(api.hasToken).toBe(false);
    await api.me();
    expect(only().headers.authorization).toBeUndefined();
  });

  it('sends the token as a Bearer header and persists it', async () => {
    const api = new Api();
    api.setToken('tok-1');
    expect(g.localStorage.getItem('nw_admin_token')).toBe('tok-1');
    await api.me();
    expect(only().headers.authorization).toBe('Bearer tok-1');
  });

  it('clearing the token removes it from storage too', () => {
    const api = new Api();
    api.setToken('tok-1');
    api.setToken(null);
    expect(api.hasToken).toBe(false);
    expect(g.localStorage.getItem('nw_admin_token')).toBeNull();
  });

  it('sets content-type only when there is a body', async () => {
    const api = new Api();
    await api.me(); // GET, no body
    expect(only()['headers']['content-type']).toBeUndefined();
    calls = [];
    nextReply = { json: { ok: true, account: {} } };
    await api.resetPassword('a1', 'pw');
    expect(only().headers['content-type']).toBe('application/json');
  });

  it('login stores the returned token so the next call is authenticated', async () => {
    const api = new Api();
    nextReply = { json: { ok: true, token: 'fresh', admin: { id: 'a' }, capabilities: [] } };
    await api.login('root', 'hunter2');
    expect(api.hasToken).toBe(true);
    calls = [];
    await api.me();
    expect(only().headers.authorization).toBe('Bearer fresh');
  });

  it('logout clears the token even when the request fails', async () => {
    const api = new Api();
    api.setToken('tok-1');
    nextReply = { status: 500, json: { ok: false, error: 'boom' } };
    await api.logout(); // must not throw: the local session is gone either way
    expect(api.hasToken).toBe(false);
  });
});

describe('transport: error mapping', () => {
  it('turns a rejected fetch into a network ApiError', async () => {
    const api = new Api();
    nextReply = { throws: new TypeError('Failed to fetch') };
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'network', message: 'Failed to fetch' });
  });

  it('falls back to a generic message when the network error carries none', async () => {
    const api = new Api();
    nextReply = { throws: new TypeError('') };
    await expect(api.me()).rejects.toMatchObject({ code: 'network', message: 'Network error' });
  });

  it('maps the backend code+error fields onto ApiError', async () => {
    const api = new Api();
    nextReply = { status: 400, json: { ok: false, code: 'BAD_REQUEST', error: 'username too short' } };
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: 'username too short' });
  });

  it('falls back to the HTTP status when the body carries no code/error', async () => {
    const api = new Api();
    nextReply = { status: 502, json: {} };
    await expect(api.me()).rejects.toMatchObject({ status: 502, code: '502', message: 'HTTP 502' });
  });

  it('treats an unparseable body as empty rather than crashing', async () => {
    const api = new Api();
    g.fetch = (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) });
    };
    await expect(api.me()).rejects.toMatchObject({ status: 500, code: '500', message: 'HTTP 500' });
  });

  it('rejects a 200 that says ok:false — the backend reports some failures that way', async () => {
    const api = new Api();
    nextReply = { status: 200, json: { ok: false, code: 'CONFLICT', error: 'already exists' } };
    await expect(api.me()).rejects.toMatchObject({ status: 200, code: 'CONFLICT' });
  });
});

describe('transport: mid-session 401', () => {
  it('clears the token and notifies the shell', async () => {
    const api = new Api();
    api.setToken('expired');
    let notified = 0;
    api.onUnauthorized = () => { notified += 1; };
    nextReply = { status: 401, json: { ok: false, code: 'UNAUTHORIZED', error: 'token expired' } };
    await expect(api.accounts()).rejects.toMatchObject({ status: 401 });
    expect(api.hasToken).toBe(false);
    expect(notified).toBe(1);
  });

  it('does NOT redirect when the 401 is the login request itself', async () => {
    // Bad credentials must show an error on the login form, not bounce back to it.
    const api = new Api();
    let notified = 0;
    api.onUnauthorized = () => { notified += 1; };
    nextReply = { status: 401, json: { ok: false, code: 'UNAUTHORIZED', error: 'bad credentials' } };
    await expect(api.login('root', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(notified).toBe(0);
  });

  it('survives a 401 with no handler installed', async () => {
    const api = new Api();
    api.setToken('expired');
    nextReply = { status: 401, json: { ok: false } };
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(api.hasToken).toBe(false);
  });
});

// ── endpoint surface ──

interface EndpointCase {
  name: string;
  call: (api: Api) => Promise<unknown>;
  method: string;
  /** Exact path + query string, as the client builds it. */
  path: string;
  /** Expected JSON body, or undefined for "no body at all". */
  body?: unknown;
  /** The reply the fake backend gives (always merged with ok:true). */
  reply?: Record<string, unknown>;
  /** What the method must return — the unwrapping half. */
  returns?: unknown;
}

const CASES: EndpointCase[] = [
  // Auth / monitoring
  { name: 'login', call: (a) => a.login('root', 'pw'), method: 'POST', path: '/admin/login',
    body: { username: 'root', password: 'pw' }, reply: { token: 't', admin: { id: 'a' }, capabilities: [] },
    returns: { ok: true, token: 't', admin: { id: 'a' }, capabilities: [] } },
  { name: 'me', call: (a) => a.me(), method: 'GET', path: '/admin/me', reply: { admin: { id: 'a' }, capabilities: ['monitor.view'] } },
  { name: 'logout', call: (a) => a.logout(), method: 'POST', path: '/admin/logout' },
  { name: 'monitorLive', call: (a) => a.monitorLive(), method: 'GET', path: '/admin/monitor/live', reply: { online: 3 } },
  { name: 'trend without a window', call: (a) => a.trend('online'), method: 'GET', path: '/admin/monitor/trend?metric=online',
    reply: { points: [{ ts: 1, value: 2 }] }, returns: [{ ts: 1, value: 2 }] },
  { name: 'trend with a from timestamp', call: (a) => a.trend('game load', 1234), method: 'GET',
    path: '/admin/monitor/trend?metric=game+load&from=1234', reply: { points: [] }, returns: [] },
  { name: 'analyticsSummary', call: (a) => a.analyticsSummary(), method: 'GET', path: '/admin/analytics/summary', reply: { last24h: {} } },
  { name: 'analyticsEvents', call: (a) => a.analyticsEvents('dau', 7), method: 'GET', path: '/admin/analytics/events?type=dau&days=7', reply: { available: true } },
  { name: 'analyticsEvents with a platform', call: (a) => a.analyticsEvents('funnel', 30, 'web'), method: 'GET',
    path: '/admin/analytics/events?type=funnel&days=30&platform=web', reply: { available: true } },

  // Players
  { name: 'player escapes the publicId', call: (a) => a.player('12 3/4'), method: 'GET', path: '/admin/player/12%203%2F4',
    reply: { player: { publicId: '1234' } }, returns: { publicId: '1234' } },
  { name: 'playerByAccount', call: (a) => a.playerByAccount('acc/1'), method: 'GET', path: '/admin/player/account/acc%2F1',
    reply: { player: { publicId: 'p' } }, returns: { publicId: 'p' } },
  { name: 'searchPlayers escapes the query', call: (a) => a.searchPlayers('a&b'), method: 'GET', path: '/admin/players/search?q=a%26b',
    reply: { players: [{ accountId: 'x' }] }, returns: [{ accountId: 'x' }] },
  { name: 'resetPlayerPassword', call: (a) => a.resetPlayerPassword('acc-1', 'newpw'), method: 'POST',
    path: '/admin/players/acc-1/reset-password', body: { password: 'newpw' } },
  { name: 'banPlayer', call: (a) => a.banPlayer('acc-1'), method: 'POST', path: '/admin/accounts/acc-1/ban' },
  { name: 'unbanPlayer', call: (a) => a.unbanPlayer('acc-1'), method: 'POST', path: '/admin/accounts/acc-1/unban' },

  // Anti-cheat
  { name: 'antiCheatReviews with no options sends an empty query', call: (a) => a.antiCheatReviews(), method: 'GET',
    path: '/admin/anticheat/reviews?', reply: { reviews: [] }, returns: [] },
  { name: 'antiCheatReviews with every option', call: (a) => a.antiCheatReviews({ accountId: 'acc-1', status: 'open', limit: 100 }),
    method: 'GET', path: '/admin/anticheat/reviews?accountId=acc-1&status=open&limit=100', reply: { reviews: [] }, returns: [] },
  { name: 'resolveAntiCheatReview', call: (a) => a.resolveAntiCheatReview('r 1', 'acc-1', 'banned'), method: 'POST',
    path: '/admin/anticheat/reviews/r%201/resolve', body: { accountId: 'acc-1', resolution: 'banned' } },
  { name: 'mismatches', call: (a) => a.mismatches(), method: 'GET', path: '/admin/mismatches', reply: { mismatches: [{ roomId: 'r' }] }, returns: [{ roomId: 'r' }] },
  { name: 'suspiciousPve', call: (a) => a.suspiciousPve(), method: 'GET', path: '/admin/suspicious-pve', reply: { accounts: [] }, returns: [] },

  // Moderation queues
  { name: 'reports', call: (a) => a.reports({ status: 'open', limit: 50 }), method: 'GET', path: '/admin/reports?status=open&limit=50',
    reply: { reports: [] }, returns: [] },
  { name: 'resolveReport', call: (a) => a.resolveReport('rep-1', 'acc-1', 'upheld'), method: 'POST',
    path: '/admin/reports/rep-1/resolve', body: { accountId: 'acc-1', resolution: 'upheld' }, reply: { reputationScore: 80, action: 'mute' } },
  { name: 'appeals', call: (a) => a.appeals({ status: 'open', limit: 100 }), method: 'GET',
    path: '/admin/appeals?status=open&limit=100', reply: { appeals: [] }, returns: [] },
  { name: 'resolveAppeal without a note', call: (a) => a.resolveAppeal('ap-1', 'denied'), method: 'POST',
    path: '/admin/appeals/ap-1/resolve', body: { resolution: 'denied' } },
  { name: 'resolveAppeal with a note', call: (a) => a.resolveAppeal('ap-1', 'approved', 'first offence'), method: 'POST',
    path: '/admin/appeals/ap-1/resolve', body: { resolution: 'approved', note: 'first offence' } },
  { name: 'feedback', call: (a) => a.feedback({ limit: 200 }), method: 'GET', path: '/admin/feedback?limit=200', reply: { feedback: [] }, returns: [] },
  { name: 'reviewFeedback with no note sends an empty object', call: (a) => a.reviewFeedback('f-1'), method: 'POST',
    path: '/admin/feedback/f-1/review', body: {} },
  { name: 'reviewFeedback with an empty note clears it', call: (a) => a.reviewFeedback('f-1', ''), method: 'POST',
    path: '/admin/feedback/f-1/review', body: { note: '' } },

  // Compensation tickets
  { name: 'initiate', call: (a) => a.initiate({ scope: 'single', target: { publicId: '123456789' }, mail: { subject: 's', body: 'b', attachments: [], expireDays: 30 }, reason: 'r' }),
    method: 'POST', path: '/admin/comp/tickets',
    body: { scope: 'single', target: { publicId: '123456789' }, mail: { subject: 's', body: 'b', attachments: [], expireDays: 30 }, reason: 'r' },
    reply: { ticket: { id: 'tk-1' } }, returns: { id: 'tk-1' } },
  { name: 'tickets unfiltered', call: (a) => a.tickets(), method: 'GET', path: '/admin/comp/tickets', reply: { tickets: [] }, returns: [] },
  { name: 'tickets filtered', call: (a) => a.tickets('pending'), method: 'GET', path: '/admin/comp/tickets?status=pending', reply: { tickets: [] }, returns: [] },
  { name: 'ticketAction approve sends no body', call: (a) => a.ticketAction('tk-1', 'approve'), method: 'POST',
    path: '/admin/comp/tickets/tk-1/approve', reply: { ticket: { id: 'tk-1' } }, returns: { id: 'tk-1' } },
  { name: 'ticketAction reject always sends a note', call: (a) => a.ticketAction('tk-1', 'reject'), method: 'POST',
    path: '/admin/comp/tickets/tk-1/reject', body: { note: '' }, reply: { ticket: { id: 'tk-1' } }, returns: { id: 'tk-1' } },
  { name: 'ticketAction reject with a note', call: (a) => a.ticketAction('tk-1', 'reject', 'wrong player'), method: 'POST',
    path: '/admin/comp/tickets/tk-1/reject', body: { note: 'wrong player' }, reply: { ticket: {} }, returns: {} },
  { name: 'preview', call: (a) => a.preview('global', { filter: { kind: 'all' } }), method: 'POST', path: '/admin/comp/preview',
    body: { scope: 'global', target: { filter: { kind: 'all' } } }, reply: { recipientCount: 5, available: true } },

  // Audit / payments
  { name: 'audit omits blank filters', call: (a) => a.audit({}), method: 'GET', path: '/admin/audit?', reply: { entries: [] }, returns: [] },
  { name: 'audit with every filter', call: (a) => a.audit({ actor: 'adm-1', from: 1, to: 2 }), method: 'GET',
    path: '/admin/audit?actor=adm-1&from=1&to=2', reply: { entries: [] }, returns: [] },
  { name: 'audit sends from=0 rather than dropping it', call: (a) => a.audit({ from: 0 }), method: 'GET',
    path: '/admin/audit?from=0', reply: { entries: [] }, returns: [] },
  { name: 'paddleEvents', call: (a) => a.paddleEvents({ accountId: 'acc-1', transactionId: 'txn_1', limit: 20 }), method: 'GET',
    path: '/admin/paddle/events?accountId=acc-1&transactionId=txn_1&limit=20', reply: { events: [] }, returns: [] },

  // Ladder / balance
  { name: 'ladderGetCurrentSeason', call: (a) => a.ladderGetCurrentSeason(), method: 'GET', path: '/admin/ladder/season/current',
    reply: { season: { seasonNo: 3, startAt: 1, endAt: 2, state: 'active' } }, returns: { seasonNo: 3, startAt: 1, endAt: 2, state: 'active' } },
  { name: 'ladderGetCurrentSeason passes null through', call: (a) => a.ladderGetCurrentSeason(), method: 'GET',
    path: '/admin/ladder/season/current', reply: { season: null }, returns: null },
  { name: 'ladderRollSeason', call: (a) => a.ladderRollSeason(), method: 'POST', path: '/admin/ladder/season/roll',
    reply: { season: { seasonNo: 4 } }, returns: { seasonNo: 4 } },
  { name: 'pvpCardStats with no filter sends no query string at all', call: (a) => a.pvpCardStats(), method: 'GET',
    path: '/admin/pvp-card-stats', reply: { cards: [] }, returns: [] },
  { name: 'pvpCardStats filtered', call: (a) => a.pvpCardStats({ mode: 'ranked', since: '20260801' }), method: 'GET',
    path: '/admin/pvp-card-stats?mode=ranked&since=20260801', reply: { cards: [] }, returns: [] },

  // Ops accounts
  { name: 'accounts', call: (a) => a.accounts(), method: 'GET', path: '/admin/accounts', reply: { accounts: [] }, returns: [] },
  { name: 'createAccount', call: (a) => a.createAccount({ username: 'u', password: 'p', role: 'ops', displayName: 'U' }), method: 'POST',
    path: '/admin/accounts', body: { username: 'u', password: 'p', role: 'ops', displayName: 'U' }, reply: { account: { id: 'a' } }, returns: { id: 'a' } },
  { name: 'updateAccount', call: (a) => a.updateAccount('a 1', { disabled: true }), method: 'PATCH', path: '/admin/accounts/a%201',
    body: { disabled: true }, reply: { account: { id: 'a 1' } }, returns: { id: 'a 1' } },
  { name: 'resetPassword', call: (a) => a.resetPassword('a-1', 'pw'), method: 'POST', path: '/admin/accounts/a-1/reset-password', body: { password: 'pw' } },

  // Config
  { name: 'flags', call: (a) => a.flags(), method: 'GET', path: '/admin/config/flags', reply: { flags: [] }, returns: [] },
  { name: 'upsertFlag', call: (a) => a.upsertFlag('client_log_debug', { enabled: true, rollout: { pct: 10 } }), method: 'PUT',
    path: '/admin/config/flags/client_log_debug', body: { enabled: true, rollout: { pct: 10 } }, reply: { flag: { key: 'k' } }, returns: { key: 'k' } },
  { name: 'slgShopItems', call: (a) => a.slgShopItems(), method: 'GET', path: '/admin/config/slg-shop', reply: { items: [] }, returns: [] },
  { name: 'upsertSlgShopItem', call: (a) => a.upsertSlgShopItem('speedup_1h', { cost: 20 }), method: 'PUT',
    path: '/admin/config/slg-shop/speedup_1h', body: { cost: 20 }, reply: { item: { id: 'i' } }, returns: { id: 'i' } },

  // Moderation word lists
  { name: 'moderationWordlists unwraps `regions`', call: (a) => a.moderationWordlists(), method: 'GET', path: '/admin/moderation/wordlists',
    reply: { regions: [{ region: 'global' }] }, returns: [{ region: 'global' }] },
  { name: 'addModerationWord', call: (a) => a.addModerationWord('cn', 'bad word'), method: 'POST',
    path: '/admin/moderation/wordlists/cn/words', body: { word: 'bad word' }, reply: { doc: { region: 'cn' } }, returns: { region: 'cn' } },
  { name: 'removeModerationWord escapes the word into the path', call: (a) => a.removeModerationWord('de', 'bad/word'), method: 'DELETE',
    path: '/admin/moderation/wordlists/de/words/bad%2Fword', reply: { doc: { region: 'de' } }, returns: { region: 'de' } },

  // Timed events
  { name: 'events', call: (a) => a.events(), method: 'GET', path: '/admin/events', reply: { events: [] }, returns: [] },
  { name: 'createEvent', call: (a) => a.createEvent({ title: 't', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] }), method: 'POST',
    path: '/admin/events', body: { title: 't', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] }, reply: { event: { _id: 'e' } }, returns: { _id: 'e' } },
  { name: 'updateEvent', call: (a) => a.updateEvent('e 1', { title: 't', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] }), method: 'PATCH',
    path: '/admin/events/e%201', body: { title: 't', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] }, reply: { event: {} }, returns: {} },
  { name: 'deleteEvent', call: (a) => a.deleteEvent('e-1'), method: 'DELETE', path: '/admin/events/e-1' },

  // Promo codes
  { name: 'promoCodes', call: (a) => a.promoCodes(), method: 'GET', path: '/admin/promo/codes', reply: { codes: [] }, returns: [] },
  { name: 'createPromoCode', call: (a) => a.createPromoCode({ code: 'WELCOME', coins: 100 }), method: 'POST', path: '/admin/promo/codes',
    body: { code: 'WELCOME', coins: 100 }, reply: { code: 'WELCOME' } },

  // Gacha
  { name: 'gachaPools', call: (a) => a.gachaPools(), method: 'GET', path: '/admin/gacha/pools', reply: { pools: [] }, returns: [] },
  { name: 'gachaCatalog', call: (a) => a.gachaCatalog(), method: 'GET', path: '/admin/gacha/catalog', reply: { catalog: { material: [] } }, returns: { material: [] } },
  { name: 'createCustomPool', call: (a) => a.createCustomPool({ id: 'p', name: 'P', costSingle: 150, startAt: 1, endAt: 2, categories: [] }),
    method: 'POST', path: '/admin/gacha/pools/custom',
    body: { id: 'p', name: 'P', costSingle: 150, startAt: 1, endAt: 2, categories: [] }, reply: { id: 'p' } },
  { name: 'closeGachaPool', call: (a) => a.closeGachaPool('p-1'), method: 'POST', path: '/admin/gacha/pools/close', body: { id: 'p-1' } },

  // SLG season lifecycle
  { name: 'slgListWorlds', call: (a) => a.slgListWorlds(), method: 'GET', path: '/admin/slg/worlds', reply: { worlds: [] }, returns: [] },
  { name: 'slgOpenSeason', call: (a) => a.slgOpenSeason('s1-0', 1, 0, 10000), method: 'POST', path: '/admin/slg/season/open',
    body: { worldId: 's1-0', season: 1, shard: 0, capacity: 10000 } },
  { name: 'slgSettleSeason unwraps `ranking`', call: (a) => a.slgSettleSeason('s1-0'), method: 'POST', path: '/admin/slg/season/settle',
    body: { worldId: 's1-0' }, reply: { ranking: [{ sectId: 'x' }] }, returns: [{ sectId: 'x' }] },
  { name: 'slgResetSeason', call: (a) => a.slgResetSeason('s1-0'), method: 'POST', path: '/admin/slg/season/reset', body: { worldId: 's1-0' } },
  { name: 'slgCloseSeason', call: (a) => a.slgCloseSeason('s1-0'), method: 'POST', path: '/admin/slg/season/close', body: { worldId: 's1-0' } },
  { name: 'slgMergeShard', call: (a) => a.slgMergeShard('s1-1', 's1-0'), method: 'POST', path: '/admin/slg/season/merge',
    body: { worldId: 's1-1', targetWorldId: 's1-0' }, reply: { result: { moved: 3, failed: [] } }, returns: { moved: 3, failed: [] } },
  { name: 'slgAllocateNextSeason without a capacity', call: (a) => a.slgAllocateNextSeason(2), method: 'POST',
    path: '/admin/slg/season/allocate', body: { season: 2 }, reply: { result: { shardCount: 1 } }, returns: { shardCount: 1 } },
  { name: 'slgAllocateNextSeason with a capacity', call: (a) => a.slgAllocateNextSeason(2, 5000), method: 'POST',
    path: '/admin/slg/season/allocate', body: { season: 2, capacity: 5000 }, reply: { result: {} }, returns: {} },

  // SLG trade audit
  { name: 'slgScanAnomalies with the default window', call: (a) => a.slgScanAnomalies('s1-0'), method: 'GET',
    path: '/admin/slg/audit/anomalies?worldId=s1-0', reply: { anomalies: [] }, returns: [] },
  { name: 'slgScanAnomalies with an explicit window', call: (a) => a.slgScanAnomalies('s1-0', 7200), method: 'GET',
    path: '/admin/slg/audit/anomalies?worldId=s1-0&windowSec=7200', reply: { anomalies: [] }, returns: [] },
  { name: 'slgQueryAuctionListings omits absent filters', call: (a) => a.slgQueryAuctionListings({ sellerId: 'acc-1' }), method: 'GET',
    path: '/admin/slg/audit/listings?sellerId=acc-1', reply: { listings: [] }, returns: [] },
  { name: 'slgQueryAuctionListings with every filter', call: (a) => a.slgQueryAuctionListings({ sellerId: 'acc-1', itemType: 'material', status: 'sold', itemName: 'ink', limit: 10 }),
    method: 'GET', path: '/admin/slg/audit/listings?sellerId=acc-1&itemType=material&status=sold&itemName=ink&limit=10',
    reply: { listings: [] }, returns: [] },
  { name: 'slgQueryAuctionListings sends limit=0 rather than dropping it', call: (a) => a.slgQueryAuctionListings({ sellerId: 'a', limit: 0 }),
    method: 'GET', path: '/admin/slg/audit/listings?sellerId=a&limit=0', reply: { listings: [] }, returns: [] },
  { name: 'slgListAuditTickets unfiltered', call: (a) => a.slgListAuditTickets(), method: 'GET', path: '/admin/slg/audit/tickets',
    reply: { tickets: [] }, returns: [] },
  { name: 'slgListAuditTickets filtered', call: (a) => a.slgListAuditTickets('open'), method: 'GET',
    path: '/admin/slg/audit/tickets?status=open', reply: { tickets: [] }, returns: [] },
  { name: 'slgFileAuditTicket wraps the snapshot', call: (a) => a.slgFileAuditTicket({ worldId: 's1-0', sellerId: 'a', buyerId: 'b', trades: 4, designatedTrades: 4, totalCoins: 9, firstTs: 1, lastTs: 2, severity: 'high', reasons: ['designated'] }),
    method: 'POST', path: '/admin/slg/audit/tickets',
    body: { snapshot: { worldId: 's1-0', sellerId: 'a', buyerId: 'b', trades: 4, designatedTrades: 4, totalCoins: 9, firstTs: 1, lastTs: 2, severity: 'high', reasons: ['designated'] } },
    reply: { ticket: { id: 't' } }, returns: { id: 't' } },
  { name: 'slgResolveAuditTicket defaults the note to empty', call: (a) => a.slgResolveAuditTicket('t 1', 'actioned'), method: 'POST',
    path: '/admin/slg/audit/tickets/t%201/resolve', body: { disposition: 'actioned', note: '' }, reply: { ticket: {} }, returns: {} },
  { name: 'slgResolveAuditTicket with a note', call: (a) => a.slgResolveAuditTicket('t-1', 'dismissed', 'false positive'), method: 'POST',
    path: '/admin/slg/audit/tickets/t-1/resolve', body: { disposition: 'dismissed', note: 'false positive' }, reply: { ticket: {} }, returns: {} },
];

describe('endpoint surface', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      nextReply = { json: { ok: true, ...(c.reply ?? {}) } };
      const api = new Api();
      api.setBaseUrl(''); // same-origin: the path under test is the whole URL
      const result = await c.call(api);
      const call = only();
      expect(call.method).toBe(c.method);
      expect(call.url).toBe(c.path);
      if (c.body === undefined) expect(call.body).toBeUndefined();
      else expect(JSON.parse(call.body!)).toEqual(c.body);
      if ('returns' in c) expect(result).toEqual(c.returns);
    });
  }

  it('covers every public method of Api', () => {
    // Without this, adding an endpoint and forgetting to add a case would leave it silently
    // unexercised — the table looks complete either way.
    const own = Object.getOwnPropertyNames(Api.prototype).filter((k) => k !== 'constructor');
    const exercised = new Set(
      CASES.flatMap((c) => own.filter((m) => new RegExp(`\\b${m}\\b`).test(c.call.toString()))),
    );
    expect([...own].filter((m) => !exercised.has(m)).sort()).toEqual([]);
    expect(own.length).toBeGreaterThan(50);
  });
});
