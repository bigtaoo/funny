// matchsvc 单测（S1-M1）：friendly 建房/加入/ready/开局 + ranked 配对，均产出可验签的
// match ticket（双方同 roomId/seed、各自 side）。push 回调录制；GameRegistry 用静态兜底地址。
import { describe, it, expect } from 'vitest';
import { verifyTicket } from '@nw/shared';
import { Matchsvc, type PushMsg } from '../src/Matchsvc';
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
    svc.roomCreate('a', 'Alice');
    const rs = last('a', 'room_state');
    expect(rs?.kind).toBe('room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    expect(rs.code).toHaveLength(6);
    expect(rs.code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    expect(rs.players[0]!.side).toBe(0);
  });

  it('输码加入（大小写无关）→ 双方进同一房，各 side', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'Alice');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'Bob', rs.code.toLowerCase());
    const rsB = last('b', 'room_state');
    if (rsB?.kind !== 'room_state') throw new Error();
    expect(rsB.players).toHaveLength(2);
    expect(rsB.players.map((p) => p.side).sort()).toEqual([0, 1]);
  });

  it('不存在的码 → ROOM_NOT_FOUND；满员 → ROOM_FULL', () => {
    const { svc, last } = setup();
    svc.roomJoin('z', 'Z', 'ZZZZZZ');
    expect(last('z', 'room_error')).toMatchObject({ code: 'ROOM_NOT_FOUND' });

    svc.roomCreate('a', 'A');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'B', rs.code);
    svc.roomJoin('c', 'C', rs.code);
    expect(last('c', 'room_error')).toMatchObject({ code: 'ROOM_FULL' });
  });

  it('双方 ready → 房主开局 → 双方收 match_found（同 roomId/seed、各 side、签名可验）', () => {
    const { svc, last } = setup();
    svc.roomCreate('a', 'Alice');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'Bob', rs.code);
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
    svc.roomCreate('a', 'A');
    const rs = last('a', 'room_state');
    if (rs?.kind !== 'room_state') throw new Error();
    svc.roomJoin('b', 'B', rs.code);
    svc.roomReady('a', true); // 仅一方 ready
    svc.roomStart('a');
    expect(last('a', 'match_found')).toBeUndefined();
    svc.roomStart('b'); // 非房主
    expect(last('b', 'match_found')).toBeUndefined();
  });

  it('控制面重连：onConnected 重发当前 room_state', () => {
    const { svc, pushed, last } = setup();
    svc.roomCreate('a', 'A');
    const before = pushed.length;
    svc.onConnected('a');
    expect(pushed.length).toBeGreaterThan(before);
    expect(last('a', 'room_state')).toBeDefined();
  });
});

describe('Matchsvc ranked', () => {
  it('两人入队 → 配对 → 双方收 match_found（mode ranked）', () => {
    const { svc, last } = setup();
    svc.enqueue('a', 'Alice', 1000);
    svc.enqueue('b', 'Bob', 1020); // 窗口内立即配
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
    svc.enqueue('a', 'A', 1000);
    svc.enqueue('b', 'B', 1000);
    expect(pushed.some((p) => p.msg.kind === 'room_error' && p.msg.code === 'GAME_UNAVAILABLE')).toBe(true);
  });
});
