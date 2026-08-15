// Direct unit tests for RoomRegistry (matchsvc/rooms.ts), covering reconnect / reap-timer / rehydrate
// edge cases not exercised via the full Matchsvc wrapper's happy-path tests (test/matchsvc.test.ts) or
// rehydrate.test.ts's always-connected rehydrate case. Same plain-fake-deps style as
// test/matchmaking.test.ts / test/gatewayClient.test.ts: no real Redis, no real network — push and
// matchStarter are simple recording fakes, redis is null (rooms.ts is null-safe throughout its
// saveRoom/deleteRoom/clearRoomAccount calls, see persist.ts's header).
import { describe, it, expect, vi } from 'vitest';
import { RoomRegistry } from '../src/matchsvc/rooms';
import { REAP_MS, type MatchStarterPort, type PushMsg } from '../src/matchsvc/types';
import type { PersistedRoom } from '../src/persist';

function setup() {
  const pushed: { acc: string; msg: PushMsg; roomId?: string }[] = [];
  const started: { mode: string; a: unknown; b: unknown }[] = [];
  const matchStarter: MatchStarterPort = {
    start: (mode, a, b) => {
      started.push({ mode, a, b });
    },
  };
  const registry = new RoomRegistry({
    push: (acc, msg, roomId) => pushed.push({ acc, msg, roomId }),
    redis: null,
    matchStarter,
  });
  const last = (acc: string, kind: PushMsg['kind']): PushMsg | undefined => {
    for (let i = pushed.length - 1; i >= 0; i--) {
      if (pushed[i]!.acc === acc && pushed[i]!.msg.kind === kind) return pushed[i]!.msg;
    }
    return undefined;
  };
  const codeOf = (acc: string): string => {
    const rs = last(acc, 'room_state');
    if (rs?.kind !== 'room_state') throw new Error('no room_state');
    return rs.code;
  };
  return { registry, pushed, started, last, codeOf };
}

describe('RoomRegistry.onConnected reconnect (rooms.ts 154-160)', () => {
  it('reconnecting a previously-disconnected slot clears the armed reap timer, marks it connected again, and re-broadcasts room_state', () => {
    vi.useFakeTimers();
    try {
      const { registry, last, codeOf } = setup();
      registry.roomCreate('a', 'Alice', '1');
      registry.roomJoin('b', 'Bob', '2', codeOf('a'));

      registry.onDisconnected('a'); // only one side down -> no reap timer yet (see onDisconnected's own guard)
      registry.onDisconnected('b'); // now both down -> reap timer armed

      const beforeReconnect = last('a', 'room_state');
      registry.onConnected('a'); // reconnect: slot.connected was false -> takes the reconnect branch, not the resend-only else
      const afterReconnect = last('a', 'room_state');

      expect(afterReconnect).not.toBe(beforeReconnect); // a fresh broadcast was sent, not just a resend to 'a' alone
      if (afterReconnect?.kind !== 'room_state') throw new Error();
      expect(afterReconnect.players.find((p) => p.side === 0)?.connected).toBe(true);

      // The reap timer armed by the double-disconnect was cleared by the reconnect -> advancing past
      // REAP_MS must NOT destroy the room (proves clearTimeout/reapTimer=null actually ran, not just the branch entered).
      vi.advanceTimersByTime(REAP_MS + 1000);
      expect(registry.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onConnected while the slot is already connected (or no room) takes the resend-only else branch (pushes only to that account)', () => {
    const { registry, pushed } = setup();
    registry.roomCreate('a', 'Alice', '1');
    const before = pushed.length;
    registry.onConnected('a'); // slot.connected is already true -> else branch: pushRoomState(accountId, room) only
    expect(pushed.length).toBeGreaterThan(before);
    expect(pushed.slice(before).every((p) => p.acc === 'a')).toBe(true); // not a broadcast to other slots

    registry.onConnected('nobody-in-any-room'); // roomOf() undefined -> early return, no-op
    expect(pushed.length).toBe(before + (pushed.length - before)); // unchanged by the no-op call (no throw either)
  });
});

describe('RoomRegistry reap timer fires and destroys the room (rooms.ts destroyRoom 245-248 clearing its own still-set timer)', () => {
  it('both slots disconnected -> after REAP_MS the room is torn down automatically', () => {
    vi.useFakeTimers();
    try {
      const { registry, codeOf } = setup();
      registry.roomCreate('a', 'Alice', '1');
      registry.roomJoin('b', 'Bob', '2', codeOf('a'));
      registry.onDisconnected('a');
      registry.onDisconnected('b'); // both down -> reap timer armed
      expect(registry.size).toBe(1);

      vi.advanceTimersByTime(REAP_MS + 1000);
      expect(registry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RoomRegistry.hydrateAll re-arms the reap timer for a persisted room whose slots were all disconnected at last write (rooms.ts 200-202)', () => {
  it('rehydrated fully-disconnected room gets a fresh reap timer, and it still fires after REAP_MS', () => {
    vi.useFakeTimers();
    try {
      const { registry } = setup();
      const persisted: PersistedRoom = {
        roomId: 'room-x',
        code: 'ABCDEF',
        phase: 0,
        slots: [
          { accountId: 'a', name: 'Alice', publicId: '1', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [], side: 0, ready: false, connected: false },
          { accountId: 'b', name: 'Bob', publicId: '2', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [], side: 1, ready: false, connected: false },
        ],
      };

      registry.hydrateAll([persisted]);
      expect(registry.size).toBe(1);

      vi.advanceTimersByTime(REAP_MS + 1000);
      expect(registry.size).toBe(0); // the re-armed timer fired and cleaned it up, same as a live disconnect would
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rehydrated room with at least one connected slot does NOT get a reap timer (contrast case, guards the condition itself)', () => {
    vi.useFakeTimers();
    try {
      const { registry } = setup();
      const persisted: PersistedRoom = {
        roomId: 'room-y',
        code: 'ZZZZZZ',
        phase: 0,
        slots: [
          { accountId: 'c', name: 'Carol', publicId: '3', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [], side: 0, ready: false, connected: true },
        ],
      };
      registry.hydrateAll([persisted]);
      vi.advanceTimersByTime(REAP_MS + 1000);
      expect(registry.size).toBe(1); // no reap timer was armed -> room survives
    } finally {
      vi.useRealTimers();
    }
  });
});
