// Room domain layer 1 (2026-08-11 split, see Room.ts's header) — server-authoritative metronome (M14):
// command intake (submitCmd) + the 10Hz frame-batch tick that drains it. Depends only on base.ts
// (broadcast/hasSide); nothing above this layer (settlement/connections) is imported here.
import { createLogger } from '@nw/shared';
import { broadcast, hasSide } from './base';
import { RoomPhase, type FrameCmds } from '../proto/transport';
import type { RoomCtx } from './types';

const log = createLogger('game');

const FRAMES_PER_BATCH = 3; // sim 30Hz ÷ net 10Hz
const BATCH_MS = 100;
// Generous upper bound on cmd_submit calls accepted within a single 100ms tick window (well above any
// legitimate input burst for a turn-based card game) — without it, a connection that floods cmd_submit
// can grow `pending` (and, once flushed, the match-long `log`/replay) without bound for as long as it
// keeps sending, since M12 forbids decoding the opaque command bytes to apply any content-aware limit.
const MAX_PENDING_PER_TICK = 200;

export function submitCmd(ctx: RoomCtx, side: number, commands: Uint8Array): void {
  if (ctx.phase !== RoomPhase.IN_MATCH) return;
  if (!hasSide(ctx, side)) return;
  if (ctx.pending.length >= MAX_PENDING_PER_TICK) {
    log.warn('cmd_submit dropped: per-tick cap reached', { roomId: ctx.roomId, side, cap: MAX_PENDING_PER_TICK });
    return;
  }
  ctx.pending.push({ side, commands });
}

export function startMetronome(ctx: RoomCtx): void {
  if (ctx.batchTimer) return;
  if (!ctx.slots.every((s) => s.conn) || ctx.slots.length !== 2) return;
  ctx.batchTimer = setInterval(() => tickBatch(ctx), BATCH_MS);
}

export function stopMetronome(ctx: RoomCtx): void {
  if (ctx.batchTimer) {
    clearInterval(ctx.batchTimer);
    ctx.batchTimer = null;
  }
}

function tickBatch(ctx: RoomCtx): void {
  ctx.curFrame += FRAMES_PER_BATCH;
  let frames: FrameCmds[] = [];
  if (ctx.pending.length > 0) {
    const cmds = [...ctx.pending].sort((a, b) => a.side - b.side); // stable sort preserves arrival order
    const fc: FrameCmds = { frame: ctx.curFrame, cmds };
    ctx.log.push(fc);
    frames = [fc];
    ctx.pending = [];
  }
  broadcast(ctx, (c) => c.send({ case: 'frame_batch', toFrame: ctx.curFrame, frames }));
}
