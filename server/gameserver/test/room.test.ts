// Room 单测（S1-M2/M3，瘦身后）：ticket 驱动开局（seed 入构造、双方凑齐自动 launch）、
// 节拍器确定性排序、空窗水位、重连补帧、局末 hash 比对 + 上报 meta、内嵌录像、掉线宽限判负。
//
// 锁步「唯一排序权威」在服务器——这层一旦回归，双端逐 tick 静默发散。故直测 Room，
// 注入假 Connection 收 outbox，并用假 report 捕获局末上报载荷（ELO 结算已移到 meta）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/Connection';
import { Room, type MatchReport, type EloBySide } from '../src/Room';
import { MatchMode, type ServerMsg } from '../src/proto/transport';

interface FakeConn {
  roomId: string;
  side: 0 | 1;
  accountId: string;
  alive: boolean;
  outbox: ServerMsg[];
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}
function makeConn(side: 0 | 1, accountId: string): FakeConn {
  return {
    roomId: 'room-1',
    side,
    accountId,
    alive: true,
    outbox: [],
    send(msg) {
      this.outbox.push(msg);
    },
    close() {},
  };
}
const asConn = (c: FakeConn): Connection => c as unknown as Connection;

function lastOf<T extends ServerMsg['case']>(
  c: FakeConn,
  kase: T,
): Extract<ServerMsg, { case: T }> | undefined {
  for (let i = c.outbox.length - 1; i >= 0; i--) {
    if (c.outbox[i]!.case === kase) return c.outbox[i] as Extract<ServerMsg, { case: T }>;
  }
  return undefined;
}

const SEED = 123456;

describe('Room', () => {
  let reports: MatchReport[];
  let destroyed: string[];
  let eloReturn: EloBySide | null;
  let room: Room;
  let c0: FakeConn;
  let c1: FakeConn;

  beforeEach(() => {
    vi.useFakeTimers();
    reports = [];
    destroyed = [];
    eloReturn = null;
    room = new Room('room-1', SEED, MatchMode.FRIENDLY, {
      onDestroy: (id) => destroyed.push(id),
      report: async (r) => {
        reports.push(r);
        return eloReturn;
      },
    });
    c0 = makeConn(0, 'acc-0');
    c1 = makeConn(1, 'acc-1');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** 两张 ticket 凑齐即开局（无 ready / 房主）。 */
  function startMatch(): void {
    room.addPlayer(asConn(c0), 'n0');
    room.addPlayer(asConn(c1), 'n1');
  }

  it('双方凑齐自动开局：同 seed（来自 ticket）+ 各自 local_side', () => {
    startMatch();
    const m0 = lastOf(c0, 'match_start')!;
    const m1 = lastOf(c1, 'match_start')!;
    expect(m0.seed).toBe(SEED);
    expect(m1.seed).toBe(SEED);
    expect(m0.localSide).toBe(0);
    expect(m1.localSide).toBe(1);
  });

  it('第一名就位不开局，第二名到位才 launch', () => {
    room.addPlayer(asConn(c0), 'n0');
    expect(lastOf(c0, 'match_start')).toBeUndefined();
    room.addPlayer(asConn(c1), 'n1');
    expect(lastOf(c0, 'match_start')).toBeDefined();
  });

  it('tickBatch 按 side 升序稳定排序（同 side 保到达序）', () => {
    startMatch();
    room.submitCmd(0, new Uint8Array([1]));
    room.submitCmd(1, new Uint8Array([9]));
    room.submitCmd(0, new Uint8Array([2]));
    vi.advanceTimersByTime(100);

    const fb = lastOf(c0, 'frame_batch')!;
    expect(fb.toFrame).toBe(3);
    expect(fb.frames).toHaveLength(1);
    const cmds = fb.frames[0]!.cmds;
    expect(cmds.map((s) => s.side)).toEqual([0, 0, 1]);
    expect(cmds.map((s) => s.commands[0])).toEqual([1, 2, 9]);
  });

  it('空窗只发水位，curFrame 每拍 +3 单调', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(3);
    expect(lastOf(c0, 'frame_batch')!.frames).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(6);
  });

  it('重连 conn_resync 只补 frame > lastFrame 的非空帧，带 seed + curFrame', () => {
    startMatch();
    for (let i = 0; i < 3; i++) {
      room.submitCmd(1, new Uint8Array([i]));
      vi.advanceTimersByTime(100);
    }
    room.onDisconnect(1, asConn(c1));
    c1.outbox = [];
    room.resume(asConn(c1), 6);

    const rs = lastOf(c1, 'conn_resync')!;
    expect(rs.seed).toBe(SEED);
    expect(rs.curFrame).toBe(9);
    expect(rs.log.map((f) => f.frame)).toEqual([9]);
  });

  it('reportResult 双方 hash 一致 → match_over base + 上报 hashOk', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    room.reportResult(0, 'HASH', 0);
    expect(reports).toHaveLength(0); // 等另一方
    room.reportResult(1, 'HASH', 0);

    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('base');
    expect(mo.mismatch).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.hashOk).toBe(true);
    expect(reports[0]!.winnerSide).toBe(-1); // friendly 正常结束胜负客户端权威
  });

  it('reportResult hash 不一致 → match_over mismatch', () => {
    startMatch();
    room.reportResult(0, 'HASH-A', 0);
    room.reportResult(1, 'HASH-B', 1);
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('mismatch');
    expect(mo.mismatch).toBe(true);
    expect(reports[0]!.hashOk).toBe(false);
  });

  it('结算幂等：settled 后重复 report 不二次上报', () => {
    startMatch();
    room.reportResult(0, 'H', 0);
    room.reportResult(1, 'H', 0);
    room.reportResult(1, 'H', 0); // 迟到
    expect(reports).toHaveLength(1);
  });

  it('内嵌录像 frames 与节拍器非空帧日志一致', () => {
    startMatch();
    room.submitCmd(0, new Uint8Array([7]));
    vi.advanceTimersByTime(100); // frame 3 有内容
    vi.advanceTimersByTime(100); // frame 6 空
    room.reportResult(0, 'H', 0);
    room.reportResult(1, 'H', 0);

    const rep = reports[0]!.replay;
    expect(rep.engineVersion).toBe(0);
    expect(rep.mode).toBe('netplay');
    expect(rep.seed).toBe(SEED);
    expect(rep.endFrame).toBe(6);
    expect(rep.frames.map((f) => f.frame)).toEqual([3]);
    expect(rep.frames[0]!.cmds[0]!.commands[0]).toBe(7);
  });

  it('掉线超过宽限 → 在线方判负 + 上报 disconnect', () => {
    startMatch();
    room.onDisconnect(1, asConn(c1));
    expect(lastOf(c0, 'peer_dc')!.side).toBe(1);
    expect(reports).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('disconnect');
    expect(reports[0]!.winnerSide).toBe(0); // 在线方（side 0）胜
    expect(destroyed).toContain('room-1');
  });

  it('显式 leave 对局中视同认输（对手胜）', () => {
    startMatch();
    room.leave(0);
    expect(reports[0]!.reason).toBe('disconnect');
    expect(reports[0]!.winnerSide).toBe(1);
  });

  it('掉线后双方重连 → 清宽限、不判负、续发节拍', () => {
    startMatch();
    room.onDisconnect(1, asConn(c1));
    room.resume(asConn(c1), 0);
    vi.advanceTimersByTime(60_000);
    expect(reports).toHaveLength(0);
    expect(lastOf(c0, 'frame_batch')).toBeDefined();
  });

  it('ranked 双方一致 → 上报得 ELO，转进 match_over.elo', async () => {
    const ranked = new Room('room-r', SEED, MatchMode.RANKED, {
      onDestroy: () => {},
      report: async () => ({ 0: { delta: 16, after: 1016, rankAfter: 'silver' }, 1: { delta: -16, after: 984, rankAfter: 'bronze' } }),
    });
    const r0 = makeConn(0, 'acc-0');
    const r1 = makeConn(1, 'acc-1');
    ranked.addPlayer(asConn(r0), 'n0');
    ranked.addPlayer(asConn(r1), 'n1');
    ranked.reportResult(0, 'H', 0);
    ranked.reportResult(1, 'H', 0);
    await vi.runAllTimersAsync(); // ranked 等 report 回 ELO 再下发 match_over
    const mo0 = lastOf(r0, 'match_over')!;
    expect(mo0.winnerSide).toBe(0);
    expect(mo0.elo).toEqual({ delta: 16, after: 1016, rankAfter: 'silver' });
    const mo1 = lastOf(r1, 'match_over')!;
    expect(mo1.elo).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });
  });
});
