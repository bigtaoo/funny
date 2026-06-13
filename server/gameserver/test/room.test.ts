// Room 单测（S1-1~5 / S1-RP）：节拍器确定性排序、空窗水位、重连补帧、
// 局末 hash 比对 + 结算幂等、内嵌录像、掉线宽限判负。
//
// 锁步「唯一排序权威」在服务器——这层一旦回归，双端逐 tick 静默发散，
// 客户端再多确定性测试也兜不住。故此处直测 Room，注入假 Connection 收 outbox。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/Connection';
import { Room, type MatchArchive } from '../src/Room';
import { MatchMode, type ServerMsg } from '../src/proto/transport';

// 假连接：duck-type Connection，send 直接收 ServerMsg（不经 protobuf 编码）。
interface FakeConn {
  accountId: string;
  roomId: string | null;
  alive: boolean;
  outbox: ServerMsg[];
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}
function makeConn(accountId: string): FakeConn {
  return {
    accountId,
    roomId: null,
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

describe('Room', () => {
  let archived: MatchArchive[];
  let destroyed: string[];
  let room: Room;
  let c0: FakeConn;
  let c1: FakeConn;

  beforeEach(() => {
    vi.useFakeTimers();
    archived = [];
    destroyed = [];
    room = new Room('room-1', 'ABCDEF', MatchMode.FRIENDLY, {
      onDestroy: (id) => destroyed.push(id),
      archive: (doc) => archived.push(doc),
    });
    c0 = makeConn('acc-0');
    c1 = makeConn('acc-1');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** 推进到 IN_MATCH（双方加入 + ready + 房主开局）。 */
  function startMatch(): void {
    room.addPlayer(asConn(c0));
    room.addPlayer(asConn(c1));
    room.setReady('acc-0', true);
    room.setReady('acc-1', true);
    room.start('acc-0');
  }

  it('双方同 seed + 各自 local_side 开局', () => {
    startMatch();
    const m0 = lastOf(c0, 'match_start')!;
    const m1 = lastOf(c1, 'match_start')!;
    expect(m0.seed).toBe(m1.seed);
    expect(m0.seed).toBeGreaterThan(0);
    expect(m0.localSide).toBe(0);
    expect(m1.localSide).toBe(1);
  });

  it('tickBatch 按 side 升序稳定排序（同 side 保到达序）', () => {
    startMatch();
    // 到达序：side0-A, side1, side0-B —— 期望排序后 [side0-A, side0-B, side1]
    room.submitCmd('acc-0', new Uint8Array([1]));
    room.submitCmd('acc-1', new Uint8Array([9]));
    room.submitCmd('acc-0', new Uint8Array([2]));
    vi.advanceTimersByTime(100);

    const fb = lastOf(c0, 'frame_batch')!;
    expect(fb.toFrame).toBe(3);
    expect(fb.frames).toHaveLength(1);
    const cmds = fb.frames[0]!.cmds;
    expect(cmds.map((s) => s.side)).toEqual([0, 0, 1]);
    expect(cmds.map((s) => s.commands[0])).toEqual([1, 2, 9]); // 同 side 内到达序稳定
  });

  it('空窗只发水位，curFrame 每拍 +3 单调', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(3);
    expect(lastOf(c0, 'frame_batch')!.frames).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(6);
    expect(lastOf(c0, 'frame_batch')!.frames).toEqual([]);
  });

  it('重连 conn_resync 只补 frame > lastFrame 的非空帧，带 seed + curFrame', () => {
    startMatch();
    // 在 frame 3 / 6 / 9 各落一条指令
    for (let i = 0; i < 3; i++) {
      room.submitCmd('acc-1', new Uint8Array([i]));
      vi.advanceTimersByTime(100);
    }
    const seed = lastOf(c1, 'match_start')!.seed;

    // c1 掉线（停节拍 + 起宽限），再以 lastFrame=6 重连
    room.onDisconnect('acc-1', asConn(c1));
    c1.outbox = [];
    room.resume(asConn(c1), 6);

    const rs = lastOf(c1, 'conn_resync')!;
    expect(rs.seed).toBe(seed);
    expect(rs.curFrame).toBe(9);
    expect(rs.log.map((f) => f.frame)).toEqual([9]); // 只补 >6 的
  });

  it('reportResult 双方 hash 一致 → match_over base + 归档 hashOk', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    room.reportResult('acc-0', 'HASH');
    expect(archived).toHaveLength(0); // 等另一方
    room.reportResult('acc-1', 'HASH');

    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('base');
    expect(mo.mismatch).toBe(false);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.hashOk).toBe(true);
    expect(archived[0]!.winner).toBe(-1); // friendly 正常结束胜负客户端权威
  });

  it('reportResult hash 不一致 → match_over mismatch', () => {
    startMatch();
    room.reportResult('acc-0', 'HASH-A');
    room.reportResult('acc-1', 'HASH-B');
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('mismatch');
    expect(mo.mismatch).toBe(true);
    expect(archived[0]!.hashOk).toBe(false);
  });

  it('结算幂等：settled 后重复 report 不二次归档', () => {
    startMatch();
    room.reportResult('acc-0', 'H');
    room.reportResult('acc-1', 'H');
    room.reportResult('acc-1', 'H'); // 迟到
    expect(archived).toHaveLength(1);
  });

  it('内嵌录像 frames 与节拍器非空帧日志一致', () => {
    startMatch();
    room.submitCmd('acc-0', new Uint8Array([7]));
    vi.advanceTimersByTime(100); // frame 3 有内容
    vi.advanceTimersByTime(100); // frame 6 空
    const seed = lastOf(c0, 'match_start')!.seed;
    room.reportResult('acc-0', 'H');
    room.reportResult('acc-1', 'H');

    const rep = archived[0]!.replay;
    expect(rep.engineVersion).toBe(0); // 服务器逻辑无关，客户端回放自校验
    expect(rep.mode).toBe('netplay');
    expect(rep.seed).toBe(seed);
    expect(rep.endFrame).toBe(6);
    expect(rep.frames.map((f) => f.frame)).toEqual([3]); // 只录非空帧
    expect(rep.frames[0]!.cmds[0]!.commands[0]).toBe(7);
  });

  it('掉线超过宽限 → 在线方判负 + 归档 disconnect', () => {
    startMatch();
    room.onDisconnect('acc-1', asConn(c1)); // c1 掉线，c0 在线
    expect(lastOf(c0, 'peer_dc')!.side).toBe(1);
    expect(archived).toHaveLength(0); // 宽限内不结算

    vi.advanceTimersByTime(60_000); // 宽限到
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('disconnect');
    expect(archived[0]!.winner).toBe(0); // 在线方（side 0）胜
    expect(destroyed).toContain('room-1');
  });

  it('显式 leave 对局中视同认输（对手胜）', () => {
    startMatch();
    room.leave('acc-0');
    expect(archived[0]!.reason).toBe('disconnect');
    expect(archived[0]!.winner).toBe(1); // 对手 side 1 胜
  });

  it('掉线后双方重连 → 清宽限、不判负、续发节拍', () => {
    startMatch();
    room.onDisconnect('acc-1', asConn(c1));
    room.resume(asConn(c1), 0); // 双方在线
    vi.advanceTimersByTime(60_000); // 原宽限时刻
    expect(archived).toHaveLength(0); // 已清宽限，未判负
    const fb = lastOf(c0, 'frame_batch');
    expect(fb).toBeDefined(); // 节拍续发
  });
});
