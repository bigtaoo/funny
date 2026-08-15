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

  // Regression for the 2026-08-04 fix: a WAITING-phase (pre-match) reconnect via a fresh ticket handshake
  // used to leave `slot.conn` pointing at the stale connection (takeover() only closed it, deliberately
  // NOT rebinding, since that dance is meant for the IN_MATCH+conn_resume path). Once the stale socket's
  // own close event was processed afterward, onDisconnect() saw an "abandoned" slot and destroyed the
  // whole room — orphaning the reconnecting player, who now holds an open socket with no room routing
  // to it, and never receives match_start once the second player joins.
  it('WAITING-phase reconnect (fresh ticket races the stale connection\'s close) does not destroy the room out from under the new connection', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY); // WAITING, only side 0 present

    // Fresh ticket handshake for the SAME side races ahead of the stale connection's close event
    // (e.g. a quick client-side reconnect after a network blip) — join() takes the takeover branch.
    const c0New = makeConn('R', 0, 'a');
    expect(mgr.join(asConn(c0New), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(c0.closedWith).toEqual({ code: 4409, reason: 'replaced' });

    // The stale connection's close event now arrives, as it would once the socket actually tears down.
    mgr.onClose(asConn(c0));

    // The room must still be alive, still waiting on the NEW connection — not destroyed.
    const c1 = makeConn('R', 1, 'b');
    expect(mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY)).toBe(true);
    expect(has(c0New, 'match_start')).toBe(true);
    expect(has(c1, 'match_start')).toBe(true);
  });

  // Regression for the 2026-08-04 defense-in-depth fix: Room.hasAccount existed but was never called
  // anywhere, so nothing prevented the SAME account from being seated on BOTH sides of one room (a
  // self-match) if a ticket bug/replay ever produced that pairing — matchsvc/gateway are expected to
  // prevent self-pairing upstream, but the data plane shouldn't have to trust that blindly.
  it('the same account cannot occupy both sides of a room (self-match rejected)', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    expect(mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(true);

    const c1SameAccount = makeConn('R', 1, 'a'); // same accountId, the OTHER side
    expect(mgr.join(asConn(c1SameAccount), 'a', '', SEED, MatchMode.FRIENDLY)).toBe(false);
    expect(has(c0, 'match_start')).toBe(false); // still waiting — the bogus second seat never landed
  });

  it('activeAccountIds() reports every accountId rostered across live rooms, deduped, across WAITING and IN_MATCH phases', () => {
    const mgr = newManager();
    const c0 = makeConn('R1', 0, 'a');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY); // R1 still WAITING (only one side)
    const c1a = makeConn('R2', 0, 'b');
    const c1b = makeConn('R2', 1, 'c');
    mgr.join(asConn(c1a), 'b', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1b), 'c', '', SEED, MatchMode.FRIENDLY); // R2 now IN_MATCH

    expect(new Set(mgr.activeAccountIds())).toEqual(new Set(['a', 'b', 'c']));
  });

  it('activeAccountIds() excludes accounts from destroyed rooms', () => {
    const mgr = newManager();
    const c0 = makeConn('R1', 0, 'a');
    const c1 = makeConn('R1', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);
    mgr.destroyAll();
    expect(mgr.activeAccountIds()).toEqual([]);
  });

  it('handle(match_result) routed to the room -> both sides eventually see match_over once both report', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);
    mgr.handle(asConn(c0), { case: 'match_result', stateHash: 'H', winnerSide: 0 });
    mgr.handle(asConn(c1), { case: 'match_result', stateHash: 'H', winnerSide: 0 });
    expect(has(c0, 'match_over')).toBe(true);
    expect(has(c1, 'match_over')).toBe(true);
  });

  it('handle(conn_resume) routed to the room -> resync sent to the resuming connection', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY); // both seated -> IN_MATCH
    const c0new = makeConn('R', 0, 'a');
    mgr.handle(asConn(c0new), { case: 'conn_resume', roomId: 'R', lastFrame: 0 });
    expect(has(c0new, 'conn_resync')).toBe(true);
  });

  it('handle(ping) marks the connection alive and replies with pong', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    c0.alive = false;
    mgr.handle(asConn(c0), { case: 'ping' });
    expect(c0.alive).toBe(true);
    expect(has(c0, 'pong')).toBe(true);
  });

  it('handle(room_leave) routed to the room -> the other side sees the leaver forfeit', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    const c1 = makeConn('R', 1, 'b');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    mgr.join(asConn(c1), 'b', '', SEED, MatchMode.FRIENDLY);
    mgr.handle(asConn(c0), { case: 'room_leave' });
    expect(has(c1, 'match_over')).toBe(true);
  });

  it('handle() on a message case with no matching room is a silent no-op (does not throw)', () => {
    const mgr = newManager();
    const orphan = makeConn('no-such-room', 0, 'a');
    expect(() => mgr.handle(asConn(orphan), { case: 'cmd_submit', commands: new Uint8Array() })).not.toThrow();
  });

  it('handle() on a control-plane-only case (e.g. room_create) is ignored on the data plane (default branch)', () => {
    const mgr = newManager();
    const c0 = makeConn('R', 0, 'a');
    mgr.join(asConn(c0), 'a', '', SEED, MatchMode.FRIENDLY);
    expect(() => mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.FRIENDLY })).not.toThrow();
    expect(c0.outbox).toEqual([]); // no reply of any kind
  });
});
