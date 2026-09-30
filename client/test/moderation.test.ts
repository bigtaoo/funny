// Player safety (App Review Guideline 1.2): the client half of report / block / blocked list —
// src/ui/moderation.ts (store + flows) and the ApiClient wire shapes it drives.
//
// What the review rests on, and so what is asserted here:
//   * a block hides the player INSTANTLY — the store flips before the request goes out, and every
//     feed re-renders off onBlockedChange; a failed request puts the player back;
//   * the blocked list is per account: a different owner resets it, a stale load for a previous
//     account never lands, and a block confirmed while the load is on the wire survives it;
//   * report/block are never offered for the player themselves, nor without an API to send them to;
//   * the report/block bodies carry the category and the reported message snapshot.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isBlocked, blockedPlayers, markBlocked, markUnblocked, onBlockedChange, resetBlockedPlayers,
  syncBlockedPlayers, confirmBlock, submitReport, unblockPlayer, setModerationBackend, setModerationSink,
  safetyActions, canModerate, messageContent, requestReport, requestBlock, openPlayerCard, REPORT_TEXT_MAX,
  type ModerationBackend, type ModerationRequest,
} from '../src/ui/moderation';
import { ApiClient } from '../src/net/ApiClient';

function backend(overrides: Partial<ModerationBackend> = {}): ModerationBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    report: async (pid, ctx) => { calls.push(`report:${pid}:${JSON.stringify(ctx)}`); },
    block: async (pid, ctx) => { calls.push(`block:${pid}:${JSON.stringify(ctx)}`); },
    unblock: async (pid) => { calls.push(`unblock:${pid}`); },
    listBlocked: async () => [],
    selfPublicId: () => '100000001',
    ...overrides,
  };
}

afterEach(() => {
  resetBlockedPlayers();
  setModerationBackend(null);
  setModerationSink(null);
  vi.restoreAllMocks();
});

describe('blocked-players store', () => {
  it('marks, notifies and unmarks', () => {
    const seen: number[] = [];
    const off = onBlockedChange(() => seen.push(blockedPlayers().length));
    markBlocked('200000002', 'Troll');
    expect(isBlocked('200000002')).toBe(true);
    markBlocked('200000002', 'Troll'); // idempotent: no second notification
    markUnblocked('200000002');
    expect(isBlocked('200000002')).toBe(false);
    off();
    markBlocked('300000003', 'X');
    expect(seen).toEqual([1, 0]);
  });

  it('never treats an empty or missing id as blocked', () => {
    markBlocked('', 'nobody');
    expect(isBlocked('')).toBe(false);
    expect(isBlocked(undefined)).toBe(false);
    expect(isBlocked(null)).toBe(false);
  });

  it('loads once per account and reloads when the account changes', async () => {
    const lists: Record<string, string[]> = { a: ['200000002'], b: ['300000003'] };
    let current = 'a';
    const listBlocked = vi.fn(async () => lists[current]!.map((publicId) => ({ publicId, displayName: publicId, ts: 1 })));
    setModerationBackend(backend({ listBlocked }));

    await syncBlockedPlayers('a');
    await syncBlockedPlayers('a');
    expect(listBlocked).toHaveBeenCalledTimes(1);
    expect(isBlocked('200000002')).toBe(true);

    current = 'b';
    await syncBlockedPlayers('b');
    expect(isBlocked('200000002'), "the previous account's list must not leak").toBe(false);
    expect(isBlocked('300000003')).toBe(true);
  });

  it('drops a load that finishes after the account logged out', async () => {
    let release!: () => void;
    setModerationBackend(backend({
      listBlocked: () => new Promise((r) => { release = () => r([{ publicId: '200000002', displayName: 'x', ts: 1 }]); }),
    }));
    const pending = syncBlockedPlayers('a');
    resetBlockedPlayers();
    release();
    await pending;
    expect(isBlocked('200000002')).toBe(false);
  });

  it('keeps the blocks made this session when the list load fails (nothing un-hides on a flaky network)', async () => {
    setModerationBackend(backend({ listBlocked: async () => { throw new Error('404'); } }));
    await syncBlockedPlayers('a');
    markBlocked('400000004', 'Blocked just now');
    await syncBlockedPlayers('a', true);
    expect(isBlocked('400000004')).toBe(true);
  });

  it('keeps a block confirmed while the list load is still on the wire', async () => {
    let release!: () => void;
    setModerationBackend(backend({ listBlocked: () => new Promise((r) => { release = () => r([]); }) }));
    const pending = syncBlockedPlayers('a');
    markBlocked('400000004', 'Late');
    release();
    await pending;
    expect(isBlocked('400000004')).toBe(true);
  });
});

describe('block / report / unblock flows', () => {
  it('hides the player before the request resolves (instant), then keeps them hidden', async () => {
    let resolveBlock!: () => void;
    setModerationBackend(backend({ block: () => new Promise((r) => { resolveBlock = r; }) }));
    const done = confirmBlock({ publicId: '200000002', name: 'Troll' });
    expect(isBlocked('200000002'), 'must be hidden the moment Block is tapped').toBe(true);
    resolveBlock();
    await done;
    expect(isBlocked('200000002')).toBe(true);
  });

  it('puts the player back when the block request fails', async () => {
    setModerationBackend(backend({ block: async () => { throw new Error('500'); } }));
    await expect(confirmBlock({ publicId: '200000002', name: 'Troll' })).rejects.toThrow();
    expect(isBlocked('200000002')).toBe(false);
  });

  it('sends the triggering message with the block and the category + message with a report', async () => {
    const b = backend();
    setModerationBackend(b);
    const content = messageContent('world', 'you are bad', 'm-1');
    await confirmBlock({ publicId: '200000002', name: 'Troll', content });
    await submitReport({ publicId: '200000002', name: 'Troll', content }, 'harassment');
    expect(b.calls[0]).toBe(`block:200000002:${JSON.stringify({ content })}`);
    expect(JSON.parse(b.calls[1]!.slice('report:200000002:'.length))).toEqual({ category: 'harassment', reason: 'harassment', content });
  });

  it('only unhides after the server agreed to the unblock', async () => {
    setModerationBackend(backend({ unblock: async () => { throw new Error('500'); } }));
    markBlocked('200000002', 'Troll');
    await expect(unblockPlayer('200000002')).rejects.toThrow();
    expect(isBlocked('200000002')).toBe(true);
  });

  it('clamps the message snapshot to what the server keeps', () => {
    expect(messageContent('dm', 'x'.repeat(REPORT_TEXT_MAX + 50)).text).toHaveLength(REPORT_TEXT_MAX);
    expect(messageContent('dm', undefined)).toEqual({ channel: 'dm' });
  });
});

describe('who report / block are offered for', () => {
  it('nobody without an API or without a dialog host', () => {
    expect(canModerate('200000002')).toBe(false);
    setModerationBackend(backend());
    expect(canModerate('200000002'), 'no host installed yet').toBe(false);
    setModerationSink(() => {});
    expect(canModerate('200000002')).toBe(true);
  });

  it('never the player themselves', () => {
    setModerationBackend(backend());
    setModerationSink(() => {});
    expect(safetyActions({ publicId: '100000001', name: 'me' })).toEqual([]);
    expect(safetyActions({ publicId: '200000002', name: 'them' }).map((a) => a.labelKey)).toEqual(['friends.report', 'friends.block']);
    expect(safetyActions({ publicId: '200000002', name: 'them' }, { reportOnly: true }).map((a) => a.labelKey)).toEqual(['friends.report']);
  });

  it('routes each request to the dialog host', () => {
    const reqs: ModerationRequest[] = [];
    setModerationBackend(backend());
    setModerationSink((r) => reqs.push(r));
    const target = { publicId: '200000002', name: 'them' };
    requestReport(target);
    requestBlock(target);
    openPlayerCard(target);
    requestReport({ publicId: '100000001', name: 'me' }); // self: dropped
    expect(reqs.map((r) => r.kind)).toEqual(['report', 'block', 'card']);
    const card = reqs[2] as Extract<ModerationRequest, { kind: 'card' }>;
    expect(card.actions.map((a) => a.labelKey)).toEqual(['friends.report', 'friends.block']);
  });
});

describe('ApiClient wire shapes (POST /friends/report, POST /friends/block, GET /friends/blocked)', () => {
  function installFetch(json: unknown): Array<{ url: string; method: string; body: unknown }> {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
      return { status: 200, json: async () => json } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('report carries category and content; absent fields stay off the wire', async () => {
    const calls = installFetch({ ok: true, data: { ok: true } });
    const api = new ApiClient('https://h/api');
    await api.reportUser('200000002', { category: 'spam', content: { channel: 'dm', messageId: 'm1', text: 'buy gold' } });
    await api.reportUser('200000002');
    expect(calls[0]).toEqual({ url: 'https://h/api/friends/report', method: 'POST', body: { publicId: '200000002', category: 'spam', content: { channel: 'dm', messageId: 'm1', text: 'buy gold' } } });
    expect(calls[1]!.body).toEqual({ publicId: '200000002' });
  });

  it('block carries the triggering message', async () => {
    const calls = installFetch({ ok: true, data: { ok: true } });
    await new ApiClient('https://h/api').blockUser('200000002', { content: { channel: 'world', text: 'x' } });
    expect(calls[0]).toEqual({ url: 'https://h/api/friends/block', method: 'POST', body: { publicId: '200000002', content: { channel: 'world', text: 'x' } } });
  });

  it('lists the blocked players', async () => {
    const calls = installFetch({ ok: true, data: { blocked: [{ publicId: '200000002', displayName: 'Troll', ts: 5 }] } });
    const list = await new ApiClient('https://h/api').getBlockedUsers();
    expect(calls[0]!.url).toBe('https://h/api/friends/blocked');
    expect(calls[0]!.method).toBe('GET');
    expect(list).toEqual([{ publicId: '200000002', displayName: 'Troll', ts: 5 }]);
  });
});
