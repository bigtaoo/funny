// Room domain layer 0 (2026-08-11 split, see Room.ts's header) — pure `RoomCtx` readers with zero
// cross-file calls into any other room/*.ts module. Nothing below this file in the dependency DAG
// (base → metronome → settlement → connections); this is the shared bottom every other layer imports
// from, never the reverse.
import type { Connection } from '../Connection';
import type { PlayerSlotOut } from '../proto/transport';
import type { RoomCtx, Slot } from './types';

export function hasSide(ctx: RoomCtx, side: number): boolean {
  return ctx.slots.some((s) => s.side === side);
}
export function hasAccount(ctx: RoomCtx, accountId: string): boolean {
  return ctx.slots.some((s) => s.accountId === accountId);
}
export function slotOfSide(ctx: RoomCtx, side: number): Slot | undefined {
  return ctx.slots.find((s) => s.side === side);
}
// Pre-existing dead code (not called anywhere, incl. tests) carried over verbatim from Room.ts — out
// of scope for this split (pure physical move, zero behavior change); flagged separately for cleanup.
export function playerSlotsOut(ctx: RoomCtx): PlayerSlotOut[] {
  return ctx.slots.map((s) => ({
    side: s.side,
    name: s.name,
    ready: true,
    connected: s.conn !== null,
  }));
}
export function broadcast(ctx: RoomCtx, send: (c: Connection) => void): void {
  for (const s of ctx.slots) if (s.conn) send(s.conn);
}
