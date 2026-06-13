// RoomManager 单测（S1-2）：建房生成无歧义房间码、输码加入（大小写无关）、
// 满员 / 不存在 / 重复入房 / ranked 拒绝、连接顶替。无 Mongo（cols=null）。
//
// 注：handle() 对 create/join 是 `void this.create()` 即发即忘（纯微任务链），
// 故每次发消息后 await flush() 排空微任务再断言。
import { describe, expect, it } from 'vitest';
import { InMemoryRoomRegistry } from '@nw/shared';
import type { Connection } from '../src/Connection';
import { RoomManager } from '../src/RoomManager';
import { MatchMode, type ServerMsg } from '../src/proto/transport';

const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

interface FakeConn {
  accountId: string;
  roomId: string | null;
  alive: boolean;
  outbox: ServerMsg[];
  closed: { code: number; reason: string } | null;
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}
function makeConn(accountId: string): FakeConn {
  return {
    accountId,
    roomId: null,
    alive: true,
    outbox: [],
    closed: null,
    send(msg) {
      this.outbox.push(msg);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}
const asConn = (c: FakeConn): Connection => c as unknown as Connection;
const errOf = (c: FakeConn): string | undefined => {
  const m = c.outbox.find((x) => x.case === 'room_error');
  return m && m.case === 'room_error' ? m.code : undefined;
};
const roomStateOf = (c: FakeConn): Extract<ServerMsg, { case: 'room_state' }> | undefined =>
  c.outbox.find((m) => m.case === 'room_state') as
    | Extract<ServerMsg, { case: 'room_state' }>
    | undefined;

function newManager(): RoomManager {
  return new RoomManager(new InMemoryRoomRegistry(), null);
}

describe('RoomManager', () => {
  it('建房生成 6 位无歧义房间码（去 0/O/1/I/L）', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    mgr.register(asConn(c0));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY });
    await flush();

    const rs = roomStateOf(c0)!;
    expect(rs.code).toHaveLength(6);
    expect(rs.code).toMatch(/^[A-HJ-NP-Z2-9]+$/); // 无 0O1IL
    expect(c0.roomId).not.toBeNull();
  });

  it('输码加入大小写无关，双方进同一房间', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    const c1 = makeConn('b');
    mgr.register(asConn(c0));
    mgr.register(asConn(c1));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY });
    await flush();
    const code = roomStateOf(c0)!.code;

    mgr.handle(asConn(c1), { case: 'room_join', code: code.toLowerCase() });
    await flush();
    expect(c1.roomId).toBe(c0.roomId);
    expect(roomStateOf(c1)!.players).toHaveLength(2);
  });

  it('满员 → ROOM_FULL', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    const c1 = makeConn('b');
    const c2 = makeConn('c');
    [c0, c1, c2].forEach((c) => mgr.register(asConn(c)));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY });
    await flush();
    const code = roomStateOf(c0)!.code;
    mgr.handle(asConn(c1), { case: 'room_join', code });
    await flush();
    mgr.handle(asConn(c2), { case: 'room_join', code });
    await flush();
    expect(errOf(c2)).toBe('ROOM_FULL');
  });

  it('不存在的房间码 → ROOM_NOT_FOUND', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    mgr.register(asConn(c0));
    mgr.handle(asConn(c0), { case: 'room_join', code: 'ZZZZZZ' });
    await flush();
    expect(errOf(c0)).toBe('ROOM_NOT_FOUND');
  });

  it('ranked 建房 → RANKED_UNAVAILABLE（S1-R 前拒）', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    mgr.register(asConn(c0));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.RANKED });
    await flush();
    expect(errOf(c0)).toBe('RANKED_UNAVAILABLE');
    expect(c0.roomId).toBeNull();
  });

  it('已在房内再建房 → ALREADY_IN_ROOM', async () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    mgr.register(asConn(c0));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY });
    await flush();
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY });
    await flush();
    expect(errOf(c0)).toBe('ALREADY_IN_ROOM');
  });

  it('同账号新连接顶替旧连接（双开 / 残连）', () => {
    const mgr = newManager();
    const c0 = makeConn('a');
    const c0b = makeConn('a'); // 同账号新连接
    mgr.register(asConn(c0));
    mgr.register(asConn(c0b));
    expect(c0.closed).toEqual({ code: 4409, reason: 'replaced' });
  });
});
