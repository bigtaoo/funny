// Room unit tests (S1-M2/M3, slimmed down): ticket-driven match start (seed passed to constructor, both players auto-launch when present),
// deterministic metronome ordering, idle watermark, reconnect catch-up, end-of-match hash comparison + report to meta, embedded replay, disconnect grace-period loss.
//
// Lock-step "single sort authority" lives on the server — if this layer regresses, both clients silently diverge tick by tick. Therefore test Room directly,
// injecting a fake Connection to receive outbox messages and using a fake report callback to capture the end-of-match report payload (ELO settlement has moved to meta).
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

  /** Match starts as soon as both tickets are present (no ready / host required). */
  function startMatch(): void {
    room.addPlayer(asConn(c0), 'n0', '');
    room.addPlayer(asConn(c1), 'n1', '');
  }

  it('both players present auto-starts: same seed (from ticket) + each receives local_side', () => {
    startMatch();
    const m0 = lastOf(c0, 'match_start')!;
    const m1 = lastOf(c1, 'match_start')!;
    expect(m0.seed).toBe(SEED);
    expect(m1.seed).toBe(SEED);
    expect(m0.localSide).toBe(0);
    expect(m1.localSide).toBe(1);
  });

  it('first player present does not start; second player triggers launch', () => {
    room.addPlayer(asConn(c0), 'n0', '');
    expect(lastOf(c0, 'match_start')).toBeUndefined();
    room.addPlayer(asConn(c1), 'n1', '');
    expect(lastOf(c0, 'match_start')).toBeDefined();
  });

  it('tickBatch sorted by side ascending (same side preserves arrival order)', () => {
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

  it('idle window only sends watermark; curFrame increments by 3 each tick monotonically', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(3);
    expect(lastOf(c0, 'frame_batch')!.frames).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(lastOf(c0, 'frame_batch')!.toFrame).toBe(6);
  });

  it('reconnect conn_resync only replays frames > lastFrame with non-empty content, includes seed + curFrame', () => {
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

  it('reportResult both sides hash agree → match_over base + reports hashOk', () => {
    startMatch();
    vi.advanceTimersByTime(100);
    room.reportResult(0, 'HASH', 0);
    expect(reports).toHaveLength(0); // waiting for the other side
    room.reportResult(1, 'HASH', 0);

    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('base');
    expect(mo.mismatch).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.hashOk).toBe(true);
    expect(reports[0]!.winnerSide).toBe(-1); // friendly match ends normally; win/loss is client-authoritative
  });

  it('reportResult hash mismatch → match_over mismatch', () => {
    startMatch();
    room.reportResult(0, 'HASH-A', 0);
    room.reportResult(1, 'HASH-B', 1);
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('mismatch');
    expect(mo.mismatch).toBe(true);
    expect(reports[0]!.hashOk).toBe(false);
  });

  it('settlement idempotent: duplicate report after settled does not report twice', () => {
    startMatch();
    room.reportResult(0, 'H', 0);
    room.reportResult(1, 'H', 0);
    room.reportResult(1, 'H', 0); // late arrival
    expect(reports).toHaveLength(1);
  });

  it('embedded replay frames match non-empty metronome frame log', () => {
    startMatch();
    room.submitCmd(0, new Uint8Array([7]));
    vi.advanceTimersByTime(100); // frame 3 has content
    vi.advanceTimersByTime(100); // frame 6 is empty
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

  it('disconnect past grace period → online player wins + report disconnect', () => {
    startMatch();
    room.onDisconnect(1, asConn(c1));
    expect(lastOf(c0, 'peer_dc')!.side).toBe(1);
    expect(reports).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    const mo = lastOf(c0, 'match_over')!;
    expect(mo.reason).toBe('disconnect');
    expect(reports[0]!.winnerSide).toBe(0); // online side (side 0) wins
    expect(destroyed).toContain('room-1');
  });

  it('explicit leave mid-game counts as concede (opponent wins)', () => {
    startMatch();
    room.leave(0);
    expect(reports[0]!.reason).toBe('disconnect');
    expect(reports[0]!.winnerSide).toBe(1);
  });

  it('both reconnect after disconnect → grace period cleared, no forfeit, metronome continues', () => {
    startMatch();
    room.onDisconnect(1, asConn(c1));
    room.resume(asConn(c1), 0);
    vi.advanceTimersByTime(60_000);
    expect(reports).toHaveLength(0);
    expect(lastOf(c0, 'frame_batch')).toBeDefined();
  });

  it('ranked both sides agree → report returns ELO, forwarded in match_over.elo', async () => {
    const ranked = new Room('room-r', SEED, MatchMode.RANKED, {
      onDestroy: () => {},
      report: async () => ({ 0: { delta: 16, after: 1016, rankAfter: 'silver' }, 1: { delta: -16, after: 984, rankAfter: 'bronze' } }),
    });
    const r0 = makeConn(0, 'acc-0');
    const r1 = makeConn(1, 'acc-1');
    ranked.addPlayer(asConn(r0), 'n0', '');
    ranked.addPlayer(asConn(r1), 'n1', '');
    ranked.reportResult(0, 'H', 0);
    ranked.reportResult(1, 'H', 0);
    await vi.runAllTimersAsync(); // ranked: waits for the report to return ELO before sending match_over
    const mo0 = lastOf(r0, 'match_over')!;
    expect(mo0.winnerSide).toBe(0);
    expect(mo0.elo).toEqual({ delta: 16, after: 1016, rankAfter: 'silver' });
    const mo1 = lastOf(r1, 'match_over')!;
    expect(mo1.elo).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });
  });
});
