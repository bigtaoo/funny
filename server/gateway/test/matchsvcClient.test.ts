// MatchsvcClient unit tests (S1-M5): gateway → matchsvc internal HTTP client POSTs each control command to
// the correct endpoint with the correct body and X-Internal-Key; when baseUrl is absent no request is sent (available=false).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MatchsvcClient } from '../src/matchsvcClient';

const KEY = 'test-internal-key';
const BASE = 'http://matchsvc:8091';

interface Call {
  url: string;
  body: Record<string, unknown>;
  key: string | undefined;
}

function install(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      key: headers['x-internal-key'],
    });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return calls;
}

describe('MatchsvcClient', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = install();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('each command hits the correct endpoint with the expected body and internal key', () => {
    const c = new MatchsvcClient(BASE, KEY);
    c.roomCreate('a', 'Alice', '100000001');
    c.roomJoin('b', 'Bob', '100000002', 'ABC123');
    c.roomReady('a', true);
    c.roomStart('a');
    c.roomLeave('b');
    c.enqueue('a', 'Alice', '100000001', 1234);
    c.connected('a');
    c.disconnected('b');

    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/mm/room/create`,
      `${BASE}/mm/room/join`,
      `${BASE}/mm/room/ready`,
      `${BASE}/mm/room/start`,
      `${BASE}/mm/room/leave`,
      `${BASE}/mm/queue/enqueue`,
      `${BASE}/mm/conn/connected`,
      `${BASE}/mm/conn/disconnected`,
    ]);
    expect(calls.every((x) => x.key === KEY)).toBe(true);
    expect(calls[1]!.body).toEqual({ accountId: 'b', name: 'Bob', publicId: '100000002', code: 'ABC123', equippedTitle: '', avatarId: '', deck: [], equippedSkins: [] });
    expect(calls[5]!.body).toEqual({ accountId: 'a', name: 'Alice', publicId: '100000001', elo: 1234, equippedTitle: '', avatarId: '', platform: '', deck: [], equippedSkins: [] });
  });

  it('no baseUrl → available=false and no requests sent', () => {
    const c = new MatchsvcClient(null, KEY);
    expect(c.available).toBe(false);
    c.roomCreate('a', 'A', '100000001');
    expect(calls).toHaveLength(0);
  });

  it('duelInvite/duelRespond ("切磋") hit the correct endpoints with the expected bodies', () => {
    const c = new MatchsvcClient(BASE, KEY);
    c.duelInvite('a', 'Alice', '100000001', 'title-1', 'avatar-1', 'b', ['card_1']);
    c.duelRespond('b', 'invite-1', false); // decline: no profile args
    c.duelRespond('b', 'invite-2', true, 'Bob', '100000002', 'title-2', 'avatar-2', ['card_2']);

    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/mm/duel/invite`,
      `${BASE}/mm/duel/respond`,
      `${BASE}/mm/duel/respond`,
    ]);
    expect(calls.every((x) => x.key === KEY)).toBe(true);
    expect(calls[0]!.body).toEqual({
      accountId: 'a', name: 'Alice', publicId: '100000001',
      equippedTitle: 'title-1', avatarId: 'avatar-1', toAccountId: 'b', deck: ['card_1'], equippedSkins: [],
    });
    expect(calls[1]!.body).toEqual({
      accountId: 'b', inviteId: 'invite-1', accept: false,
      name: '', publicId: '', equippedTitle: '', avatarId: '', deck: [], equippedSkins: [],
    });
    expect(calls[2]!.body).toEqual({
      accountId: 'b', inviteId: 'invite-2', accept: true,
      name: 'Bob', publicId: '100000002', equippedTitle: 'title-2', avatarId: 'avatar-2', deck: ['card_2'], equippedSkins: [],
    });
  });
});
