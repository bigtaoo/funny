// Direct unit tests for room/base.ts's pure RoomCtx readers (previously only exercised
// indirectly — hasAccount in particular was flagged as "existed but never called" until the
// 2026-08-04 self-match fix wired it in; playerSlotsOut/broadcast had no coverage at all).
import { describe, expect, it, vi } from 'vitest';
import { hasSide, hasAccount, slotOfSide, playerSlotsOut, broadcast } from '../src/room/base';
import type { RoomCtx, Slot } from '../src/room/types';
import type { Connection } from '../src/Connection';

function makeSlot(side: number, accountId: string, conn: Connection | null = null): Slot {
  return { side, accountId, conn, name: `p${side}`, publicId: '', opponentTitle: '', opponentAvatarId: '', opponentSkins: [] } as unknown as Slot;
}
function makeCtx(slots: Slot[]): RoomCtx {
  return { slots } as unknown as RoomCtx;
}

describe('room/base', () => {
  it('hasSide / hasAccount / slotOfSide reflect the current roster', () => {
    const ctx = makeCtx([makeSlot(0, 'a'), makeSlot(1, 'b')]);
    expect(hasSide(ctx, 0)).toBe(true);
    expect(hasSide(ctx, 1)).toBe(true);
    expect(hasAccount(ctx, 'a')).toBe(true);
    expect(hasAccount(ctx, 'nobody')).toBe(false);
    expect(slotOfSide(ctx, 1)?.accountId).toBe('b');
    expect(slotOfSide(ctx, 5)).toBeUndefined();
  });

  it('empty roster: every reader reports absence, nothing throws', () => {
    const ctx = makeCtx([]);
    expect(hasSide(ctx, 0)).toBe(false);
    expect(hasAccount(ctx, 'a')).toBe(false);
    expect(slotOfSide(ctx, 0)).toBeUndefined();
    expect(playerSlotsOut(ctx)).toEqual([]);
  });

  it('playerSlotsOut maps each slot to its wire shape, connected reflecting slot.conn', () => {
    const ctx = makeCtx([makeSlot(0, 'a', {} as Connection), makeSlot(1, 'b', null)]);
    expect(playerSlotsOut(ctx)).toEqual([
      { side: 0, name: 'p0', ready: true, connected: true },
      { side: 1, name: 'p1', ready: true, connected: false },
    ]);
  });

  it('broadcast invokes send() only for slots with a live connection', () => {
    const connA = {} as Connection;
    const ctx = makeCtx([makeSlot(0, 'a', connA), makeSlot(1, 'b', null)]);
    const send = vi.fn();
    broadcast(ctx, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(connA);
  });
});
