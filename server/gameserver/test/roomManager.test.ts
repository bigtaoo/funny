// RoomManager unit tests (S1-M2, slimmed): ticket-handshake driven — find/create room by roomId, seat by side,
// cross-check that the second ticket's seed/mode match before accepting it, data-plane message routing, reconnect does not re-seat.
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
  closedWith: { code: number; reason: string } | null;
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}
function makeConn(roomId: string, side: 0 | 1, accountId: string): FakeConn {
  return {
    roomId,
    side,
    accountId,
    alive: true,
    outbox: [],
    closedWith: null,
    send(msg) {
      this.outbox.push(msg);
    },
    close(code, reason) {
      this.closedWith = { code, reason };
    },
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
  it('two tickets with matching roomId/seed (side 0/1) both joined → match starts automatically', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    expect(mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(has(c0, 'match_start')).toBe(false); // waiting for second player
    expect(mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(has(c0, 'match_start')).toBe(true);
    expect(has(c1, 'match_start')).toBe(true);
  });

  it('second ticket seed mismatch → rejected', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    expect(mgr.join(asConn(c1), 'b', '', SEED + 1, MatchMode.FRIENDLY)).toBe(false);
  });

  it('mode mismatch → rejected', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    expect(mgr.join(asConn(c1), 'b', '', SEED, MatchMode.RANKED)).toBe(false);
  });

  it('cmd_submit routed into the room → appears in frame_batch', () => {
    vi.useFakeTimers();
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);
    mgr.handle(asConn(c0), { case: 'cmd_submit', commands: new Uint8Array([42]) });
    vi.advanceTimersByTime(100);
    const fb = c0.outbox.filter((m) => m.case === 'frame_batch').at(-1);
    expect(fb && fb.case === 'frame_batch' && fb.frames[0]?.cmds[0]?.commands[0]).toBe(42);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reconnect: re-join with same roomId/side does not duplicate seating (returns true)', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);
    const c0b = makeConn('R', 0, 'a'); // reconnect
    expect(mgr.join(asConn(c0b), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(true);
  });

  it('new-device login for an already-connected side evicts the stale connection (4409 replaced)', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);

    const c0New = makeConn('R', 0, 'a'); // same account, new device/ticket takes over side 0
    expect(mgr.join(asConn(c0New), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(c0.closedWith).toEqual({ code: 4409, reason: 'replaced' });
    expect(c0New.closedWith).toBeNull();
  });
});
