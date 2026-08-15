// Isolated in its own file from rooms.test.ts because it mocks the 'crypto' module for the whole file —
// keeping it separate avoids making every other RoomRegistry test's room codes deterministically collide.
import { describe, it, expect, vi } from 'vitest';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  // Every pick becomes CODE_ALPHABET[0] -> the second room's 16 collision-avoidance attempts all fail,
  // forcing uniqueCode()'s "give up, use a deterministic fallback" path (rooms.ts line 288).
  return { ...actual, randomInt: () => 0 };
});

import { RoomRegistry } from '../src/matchsvc/rooms';
import type { MatchStarterPort, PushMsg } from '../src/matchsvc/types';

describe('RoomRegistry.uniqueCode collision fallback (rooms.ts line 288)', () => {
  it('16 consecutive collisions falls back to a deterministic zero-padded + timestamp-suffixed code instead of looping forever', () => {
    const pushed: { acc: string; msg: PushMsg }[] = [];
    const matchStarter: MatchStarterPort = { start: () => {} };
    const registry = new RoomRegistry({ push: (acc, msg) => pushed.push({ acc, msg }), redis: null, matchStarter });

    registry.roomCreate('a', 'Alice', '1'); // first room claims '000000' uncontested (byCode was empty)
    registry.roomCreate('b', 'Bob', '2'); // second room: every one of the 16 attempts collides with '000000' -> fallback

    const codeOf = (acc: string): string => {
      const rs = pushed.find((p) => p.acc === acc && p.msg.kind === 'room_state');
      if (rs?.msg.kind !== 'room_state') throw new Error('no room_state');
      return rs.msg.code;
    };
    const codeA = codeOf('a');
    const codeB = codeOf('b');
    expect(codeA).toBe('000000');
    expect(codeB).not.toBe('000000'); // fallback code, distinct from the ever-colliding random pick
    expect(codeB.startsWith('00')).toBe(true); // CODE_ALPHABET[0].repeat(CODE_LEN - 4) prefix, then a timestamp suffix
    expect(registry.size).toBe(2); // both rooms created successfully despite the collision
  });
});
