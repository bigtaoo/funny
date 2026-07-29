// Regression coverage for the 2026-07-29 fix: WorldMapContext's world-chat "last seen" marker
// (worldChatSeenKey/getWorldChatSeenTs/markWorldChatSeen) used to call the global `localStorage`
// directly instead of going through `IPlatform.storage` (WorldMapCallbacks.storage) — silently
// no-op on WeChat mini-game, which has no DOM `localStorage`. The headless UI test environment
// (vitest.ui.config.ts, `environment: 'node'`) also has no global `localStorage`, so this test
// doubles as a hard regression lock: if the bug ever comes back, calling these methods here throws
// `ReferenceError: localStorage is not defined` instead of silently no-op-ing like a real browser
// would (where it would just accidentally write to the origin's real localStorage instead).

import { describe, it, expect } from 'vitest';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldChatMessage } from '../../src/net/WorldApiClient';

function chatMsg(ts: number): WorldChatMessage {
  return { id: 'm1', senderId: 'x', senderName: 'X', senderPublicId: '000000001', body: 'hi', ts };
}

const LAYOUT = { designWidth: 1280, designHeight: 800 } as ILayout;

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

function baseCb(overrides: Partial<WorldMapCallbacks>): WorldMapCallbacks {
  return {
    onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
    onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
    worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg',
    storage: memStorage(),
    ...overrides,
  };
}

describe('WorldMapContext world-chat "last seen" marker — uses injected storage, not global localStorage', () => {
  it('getWorldChatSeenTs defaults to 0 with no thrown error (no global localStorage in this env)', () => {
    const ctx = new WorldMapContext(LAYOUT, baseCb({}));
    expect(ctx.getWorldChatSeenTs()).toBe(0);
  });

  it('markWorldChatSeen persists into cb.storage under the world+account-scoped key, and getWorldChatSeenTs reads it back', () => {
    const storage = memStorage();
    const ctx = new WorldMapContext(LAYOUT, baseCb({ worldId: 'w7', accountId: 'acc_7', storage }));
    ctx.worldChatLatest = chatMsg(123456);
    ctx.markWorldChatSeen();

    expect(storage.dump()).toEqual({ nw_worldchat_seen_w7_acc_7: '123456' });
    expect(ctx.getWorldChatSeenTs()).toBe(123456);
    expect(ctx.worldChatUnread).toBe(0);
  });

  it('falls back to Date.now() when worldChatLatest is null', () => {
    const storage = memStorage();
    const ctx = new WorldMapContext(LAYOUT, baseCb({ storage }));
    const before = Date.now();
    ctx.markWorldChatSeen();
    const seen = ctx.getWorldChatSeenTs();
    expect(seen).toBeGreaterThanOrEqual(before);
  });

  it('scopes the key by both worldId and accountId — two different worlds/accounts do not share a read marker', () => {
    const storage = memStorage();
    const ctxA = new WorldMapContext(LAYOUT, baseCb({ worldId: 'w1', accountId: 'acc_a', storage }));
    const ctxB = new WorldMapContext(LAYOUT, baseCb({ worldId: 'w1', accountId: 'acc_b', storage }));
    ctxA.worldChatLatest = chatMsg(999);
    ctxA.markWorldChatSeen();

    expect(ctxA.getWorldChatSeenTs()).toBe(999);
    expect(ctxB.getWorldChatSeenTs()).toBe(0); // acc_b's own marker untouched
  });
});
