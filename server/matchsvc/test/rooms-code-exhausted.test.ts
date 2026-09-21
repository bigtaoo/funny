// uniqueCode()'s last branch: 16 random picks collided AND the linear probe walked the whole code
// space without finding a free slot. With the real CODE_LEN that needs 10^6 live rooms, so this
// file shrinks the space instead — its own file because the mock applies to the whole module.
//
// The branch is unreachable in production (one matchsvc process will not hold a million rooms),
// but it is the difference between "room create fails with an error the client can show" and
// "uniqueCode returns a duplicate / loops forever", which is exactly what the old fallback did.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/matchsvc/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/matchsvc/types')>();
  return { ...actual, CODE_LEN: 2 }; // 2 digits -> exactly 100 codes
});

import { RoomRegistry } from '../src/matchsvc/rooms';
import type { MatchStarterPort, PushMsg } from '../src/matchsvc/types';

describe('RoomRegistry.uniqueCode with the code space full', () => {
  it('fills all 100 codes, then refuses the next create with NO_ROOM_CODE', () => {
    const pushed: { acc: string; msg: PushMsg }[] = [];
    const matchStarter: MatchStarterPort = { start: () => {} };
    const registry = new RoomRegistry({ push: (acc, msg) => pushed.push({ acc, msg }), redis: null, matchStarter });

    for (let i = 0; i < 100; i++) registry.roomCreate(`acc${i}`, `P${i}`, `${i}`);
    const codes = new Set(
      pushed.filter((p) => p.msg.kind === 'room_state').map((p) => (p.msg as { code: string }).code),
    );
    expect(codes.size).toBe(100); // every code in the space, each handed out exactly once
    expect(registry.size).toBe(100);

    registry.roomCreate('acc-overflow', 'Late', '999');
    const err = pushed.find((p) => p.acc === 'acc-overflow' && p.msg.kind === 'room_error');
    expect(err?.msg.kind === 'room_error' && err.msg.code).toBe('NO_ROOM_CODE');
    expect(registry.size).toBe(100); // no room created, and no duplicate code in byCode
  });
});
