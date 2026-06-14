// RoomManager 单测（S1-M2，瘦身后）：ticket 握手驱动——按 roomId 找/建房、按 side 入座、
// 第二张 ticket 的 seed/mode 交叉核对一致才接纳、数据面消息路由、重连不重复入座。
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/Connection';
import { RoomManager } from '../src/RoomManager';
import type { MatchReport } from '../src/Room';
import { MatchMode, type ServerMsg } from '../src/proto/transport';

interface FakeConn {
  roomId: string;
  side: 0 | 1;
  accountId: string;
  alive: boolean;
  outbox: ServerMsg[];
  send(msg: ServerMsg): void;
  close(): void;
}
function makeConn(roomId: string, side: 0 | 1, accountId: string): FakeConn {
  return {
    roomId,
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
const has = (c: FakeConn, kase: ServerMsg['case']): boolean => c.outbox.some((m) => m.case === kase);

function newManager(): RoomManager {
  const reports: MatchReport[] = [];
  const mgr = new RoomManager({
    report: async (r) => {
      reports.push(r);
      return null;
    },
  });
  return mgr;
}

const SEED = 999;

describe('RoomManager (ticket relay)', () => {
  it('两张同 roomId/seed ticket（side 0/1）凑齐 → 自动开局', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    expect(mgr.join(asConn(c0), 'a', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(has(c0, 'match_start')).toBe(false); // 等第二人
    expect(mgr.join(asConn(c1), 'b', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(has(c0, 'match_start')).toBe(true);
    expect(has(c1, 'match_start')).toBe(true);
  });

  it('第二张 ticket seed 不一致 → 拒绝', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', SEED, MatchMode.FRIENDLY);
    expect(mgr.join(asConn(c1), 'b', SEED + 1, MatchMode.FRIENDLY)).toBe(false);
  });

  it('mode 不一致 → 拒绝', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', SEED, MatchMode.FRIENDLY);
    expect(mgr.join(asConn(c1), 'b', SEED, MatchMode.RANKED)).toBe(false);
  });

  it('cmd_submit 路由进房间 → 出现在 frame_batch', () => {
    vi.useFakeTimers();
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', SEED, MatchMode.FRIENDLY);
    mgr.handle(asConn(c0), { case: 'cmd_submit', commands: new Uint8Array([42]) });
    vi.advanceTimersByTime(100);
    const fb = c0.outbox.filter((m) => m.case === 'frame_batch').at(-1);
    expect(fb && fb.case === 'frame_batch' && fb.frames[0]?.cmds[0]?.commands[0]).toBe(42);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('重连：同 roomId/side 再 join 不重复入座（返回 true）', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', SEED, MatchMode.FRIENDLY);
    const c0b = makeConn('R', 0, 'a'); // 重连
    expect(mgr.join(asConn(c0b), 'a', SEED, MatchMode.FRIENDLY)).toBe(true);
  });
});
