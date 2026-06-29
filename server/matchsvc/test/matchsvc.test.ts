// matchsvc unit tests (S1-M1): friendly room create/join/ready/start + ranked matchmaking, both producing verifiable
// match tickets (shared roomId/seed, individual side per player). Push callbacks recorded; GameRegistry uses a static fallback URL.
import { describe, it, expect, vi } from 'vitest';
import { verifyTicket, FeatureFlagCache } from '@nw/shared';
import { Matchsvc, CODE_ALPHABET, type PushMsg } from '../src/Matchsvc';
import { GameRegistry } from '../src/GameRegistry';

const KEY = 'test-internal-key';
const GAME_URL = 'ws://game:8081/ws';

function setup() {
  const pushed: { acc: string; msg: PushMsg }[] = [];
  const games = new GameRegistry(() => 0, GAME_URL);
  const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, { autoTick: false });
  const last = (acc: string, kind: PushMsg['kind']): PushMsg | undefined => {
    for (let i = pushed.length - 1; i >= 0; i--) {
      if (pushed[i]!.acc === acc && pushed[i]!.msg.kind === kind) return pushed[i]!.msg;
    }
    return undefined;
  };
  return { pushed, svc, last };
}

describe('Matchsvc friendly', () => {
  it('建房 → room_state（6 位无歧义码，建房者 side 0）', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'Alice', '100000001');
    const rs = last('a', 'room_state');
    expect(rs?.kind).toBe('room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    expect(rs.code).toHaveLength(6);
    expect(rs.code).toMatch(/^[0-9A-HJKM]+$/);
    expect(rs.players[0]!.side).toBe(0);
  });

  it('输码加入（大小写无关）→ 双方进同一房，各 side', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'Alice', '100000001');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'Bob', '100000002', rs.code.toLowerCase());
    const rsB = last('b', 'room_state');
    if (rsB?.kind !== 'room_state') throw new Error();
    expect(rsB.players).toHaveLength(2);
    expect(rsB.players.map((p) => p.side).sort()).toEqual([0, 1]);
    // Nickname + 9-digit public id are sent with room_state (room displays nicknames, not accountIds).
    expect(rsB.players.find((p) => p.side === 0)).toMatchObject({ name: 'Alice', publicId: '100000001' });
    expect(rsB.players.find((p) => p.side === 1)).toMatchObject({ name: 'Bob', publicId: '100000002' });
  });

  it('不存在的码 → ROOM_NOT_FOUND；满员 → ROOM_FULL', () => {
    const { svc, last } = setup();
    svc.roomJoin('z', 'Z', '100000099', 'ZZZZZZ');
    expect(last('z', 'room_error')).toMatchObject({ code: 'ROOM_NOT_FOUND' });

    svc.roomCreate('a', 'A', '100000001');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'B', '100000002', rs.code);
    svc.roomJoin('c', 'C', '100000003', rs.code);
    expect(last('c', 'room_error')).toMatchObject({ code: 'ROOM_FULL' });
  });

  it('双方 ready → 房主开局 → 双方收 match_found（同 roomId/seed、各 side、签名可验）', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'Alice', '100000001');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'Bob', '100000002', rs.code);
    svc.roomReady('a', true);
    svc.roomReady('b', true);
    svc.roomStart('a'); // host = side 0

    const fa = last('a', 'match_found');
    const fb = last('b', 'match_found');
    if (fa?.kind !== 'match_found' || fb?.kind !== 'match_found') throw new Error('no match_found');
    expect(fa.gameUrl).toBe(GAME_URL);
    const ta = verifyTicket(fa.ticket, { key: KEY });
    const tb = verifyTicket(fb.ticket, { key: KEY });
    expect(ta.roomId).toBe(tb.roomId);
    expect(ta.seed).toBe(tb.seed);
    expect([ta.side, tb.side].sort()).toEqual([0, 1]);
    expect(ta.mode).toBe('friendly');
    expect(ta.accountId).toBe('a');
    expect(tb.accountId).toBe('b');
  });

  it('非房主开局无效；未全 ready 不开局', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'A', '100000001');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'B', '100000002', rs.code);
    svc.roomReady('a', true); // only one side is ready
    svc.roomStart('a');
    expect(last('a', 'match_found')).toBeUndefined();
    svc.roomStart('b'); // 非房主
    expect(last('b', 'match_found')).toBeUndefined();
  });

  it('控制面重连：onConnected 重发当前 room_state', () => {
    const { svc, pushed, last } = setup();
    svc.roomCreate('a', 'A', '100000001');
    const before = pushed.length;
    svc.onConnected('a');
    expect(pushed.length).toBeGreaterThan(before);
    expect(last('a', 'room_state')).toBeDefined();
  });
});

describe('Matchsvc ranked', () => {
  it('两人入队 → 配对 → 双方收 match_found（mode ranked）', () => {
    const { svc, last } = setup();
    svc.enqueue('a', 'Alice', '100000001', 1000);
    svc.enqueue('b', 'Bob', '100000002', 1020); // within the ELO window, matched immediately
    const fa = last('a', 'match_found');
    const fb = last('b', 'match_found');
    if (fa?.kind !== 'match_found' || fb?.kind !== 'match_found') throw new Error('no match_found');
    const ta = verifyTicket(fa.ticket, { key: KEY });
    const tb = verifyTicket(fb.ticket, { key: KEY });
    expect(ta.mode).toBe('ranked');
    expect(ta.roomId).toBe(tb.roomId);
    expect(ta.seed).toBe(tb.seed);
  });

  it('无 game 可分配 → GAME_UNAVAILABLE', () => {
    const pushed: { acc: string; msg: PushMsg }[] = [];
    const games = new GameRegistry(() => 0, null); // no fallback URL, no registered instances
    const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, { autoTick: false });
    svc.enqueue('a', 'A', '100000001', 1000);
    svc.enqueue('b', 'B', '100000002', 1000);
    expect(pushed.some((p) => p.msg.kind === 'room_error' && p.msg.code === 'GAME_UNAVAILABLE')).toBe(true);
  });
});

describe('Matchsvc bot-fallback（feature flag match_bot_fallback）', () => {
  async function makeCache(docs: unknown[]): Promise<FeatureFlagCache> {
    const cache = new FeatureFlagCache({ fetchAll: async () => docs });
    await cache.refresh();
    return cache;
  }

  it('flag 开 + 单人等待超阈值 → 推 match_bot（出队，本地 AI 局）', async () => {
    vi.useFakeTimers();
    try {
      const cache = await makeCache([{ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 100 } }]);
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const games = new GameRegistry(() => 0, GAME_URL);
      const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
        flags: cache,
        botFallbackMs: 30_000,
      });
      svc.enqueue('lonely', 'L', '100000001', 1000, '', 'web');
      vi.advanceTimersByTime(31_000);
      const bot = pushed.find((p) => p.acc === 'lonely' && p.msg.kind === 'match_bot');
      expect(bot).toBeDefined();
      if (bot?.msg.kind !== 'match_bot') throw new Error();
      expect(bot.msg.seed).toBeGreaterThan(0);
      expect(bot.msg.opponentName).toBeTruthy();
      expect(bot.msg.elo).toBe(1000);
      expect(bot.msg.difficulty).toBe('normal');
      expect(svc.stats().queue).toBe(0); // dequeued
    } finally {
      vi.useRealTimers();
    }
  });

  it('flag 关 → 不降级，继续在队等真人', async () => {
    vi.useFakeTimers();
    try {
      const cache = await makeCache([]); // no overrides → default false
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const games = new GameRegistry(() => 0, GAME_URL);
      const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
        flags: cache,
        botFallbackMs: 30_000,
      });
      svc.enqueue('lonely', 'L', '100000001', 1000, '', 'web');
      vi.advanceTimersByTime(60_000);
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(false);
      expect(svc.stats().queue).toBe(1); // still in queue
    } finally {
      vi.useRealTimers();
    }
  });

  it('flag 后开（玩家已超时过一次仍在队）→ 下一次重评即降级（非 fire-once）', async () => {
    vi.useFakeTimers();
    try {
      const docs: unknown[] = []; // initially no overrides → default false
      const cache = new FeatureFlagCache({ fetchAll: async () => docs });
      await cache.refresh();
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const games = new GameRegistry(() => 0, GAME_URL);
      const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
        flags: cache,
        botFallbackMs: 30_000,
      });
      svc.enqueue('lonely', 'L', '100000001', 1000, '', 'web');
      vi.advanceTimersByTime(31_000); // first timeout: flag is off → keep waiting, entry remains in queue
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(false);
      expect(svc.stats().queue).toBe(1);

      // Operator enables the flag after the fact
      docs.push({ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 100 } });
      await cache.refresh();

      vi.advanceTimersByTime(31_000); // next re-evaluation window arrives → should fall back to bot this time
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(true);
      expect(svc.stats().queue).toBe(0); // dequeued
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Room code character set ───────────────────────────────────────────────────
// The server generator and the client keyboard must use the same character set;
// otherwise codes containing characters that cannot be typed will be issued.
// The set is fixed to 10 digits + 11 letters (skipping I/O/L), matching client RoomScene.ts's
// CODE_ALPHABET character-for-character; the client side has a corresponding assertion,
// so any change on either side will be caught by the other side's tests.
describe('Matchsvc room-code charset', () => {
  it('字符集 = 10 数字 + 11 字母（与客户端键盘一致，跳过 I/O/L）', () => {
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKM');
    expect(CODE_ALPHABET).toHaveLength(21); // exactly 3 rows × 7 = one screen
    expect(CODE_ALPHABET).not.toMatch(/[IOL]/); // avoid confusion with 0/1
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length); // no duplicates
  });

  it('生成的码只含字符集内字符（多次采样）', () => {
    const inSet = new RegExp(`^[${CODE_ALPHABET}]{6}$`);
    for (let i = 0; i < 200; i++) {
      const { svc, last } = setup();
      svc.roomCreate(`acc${i}`, 'P', '100000001');
      const rs = last(`acc${i}`, 'room_state');
      if (rs?.kind !== 'room_state') throw new Error('no room_state');
      expect(rs.code).toMatch(inSet);
    }
  });
});
