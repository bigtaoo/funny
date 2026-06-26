// matchsvc 单测（S1-M1）：friendly 建房/加入/ready/开局 + ranked 配对，均产出可验签的
// match ticket（双方同 roomId/seed、各自 side）。push 回调录制；GameRegistry 用静态兜底地址。
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
    // 昵称 + 9 位公开 id 随 room_state 下发（房间显示昵称而非 accountId）。
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
    svc.roomReady('a', true); // 仅一方 ready
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
    svc.enqueue('b', 'Bob', '100000002', 1020); // 窗口内立即配
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
    const games = new GameRegistry(() => 0, null); // 无兜底、无注册
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
      expect(svc.stats().queue).toBe(0); // 已出队
    } finally {
      vi.useRealTimers();
    }
  });

  it('flag 关 → 不降级，继续在队等真人', async () => {
    vi.useFakeTimers();
    try {
      const cache = await makeCache([]); // 无覆盖 → default false
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const games = new GameRegistry(() => 0, GAME_URL);
      const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
        flags: cache,
        botFallbackMs: 30_000,
      });
      svc.enqueue('lonely', 'L', '100000001', 1000, '', 'web');
      vi.advanceTimersByTime(60_000);
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(false);
      expect(svc.stats().queue).toBe(1); // 仍在队
    } finally {
      vi.useRealTimers();
    }
  });

  it('flag 后开（玩家已超时过一次仍在队）→ 下一次重评即降级（非 fire-once）', async () => {
    vi.useFakeTimers();
    try {
      const docs: unknown[] = []; // 起初无覆盖 → default false
      const cache = new FeatureFlagCache({ fetchAll: async () => docs });
      await cache.refresh();
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const games = new GameRegistry(() => 0, GAME_URL);
      const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
        flags: cache,
        botFallbackMs: 30_000,
      });
      svc.enqueue('lonely', 'L', '100000001', 1000, '', 'web');
      vi.advanceTimersByTime(31_000); // 第一次超时：flag 关 → 继续等，条目仍在队
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(false);
      expect(svc.stats().queue).toBe(1);

      // 运营把开关后开
      docs.push({ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 100 } });
      await cache.refresh();

      vi.advanceTimersByTime(31_000); // 下一次重评窗口到 → 这次应降级
      expect(pushed.some((p) => p.msg.kind === 'match_bot')).toBe(true);
      expect(svc.stats().queue).toBe(0); // 已出队
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 房间码字符集 ─────────────────────────────────────────────────────────────
// 服务端生成器与客户端键盘必须用同一字符集，否则会发出键盘打不出来的码。
// 这里固定字符集为 10 数字 + 11 字母（跳过 I/O/L），与 client RoomScene.ts 的
// CODE_ALPHABET 一字不差；客户端侧有对应断言，任一侧改动都会被另一侧测试抓到。
describe('Matchsvc room-code charset', () => {
  it('字符集 = 10 数字 + 11 字母（与客户端键盘一致，跳过 I/O/L）', () => {
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKM');
    expect(CODE_ALPHABET).toHaveLength(21); // 刚好 3 行 × 7 = 一屏
    expect(CODE_ALPHABET).not.toMatch(/[IOL]/); // 避免与 0/1 混淆
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length); // 无重复
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
