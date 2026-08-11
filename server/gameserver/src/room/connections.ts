// Room domain layer 3 (top, 2026-08-11 split, see Room.ts's header) — join/leave/disconnect/reconnect/
// takeover: everything that manages `ctx.slots` membership and the connections behind each slot.
// Depends on base.ts (hasSide/slotOfSide/broadcast), metronome.ts (startMetronome/stopMetronome) and
// settlement.ts (endMatch/destroy) — the top of the dependency DAG; no other room/*.ts file imports
// this one.
import { createLogger } from '@nw/shared';
import { hasSide, slotOfSide } from './base';
import { startMetronome, stopMetronome } from './metronome';
import { destroy, endMatch } from './settlement';
import { RoomPhase } from '../proto/transport';
import type { Connection } from '../Connection';
import type { RoomCtx } from './types';

const log = createLogger('game');

const GRACE_MS = 60_000; // disconnect grace period (M10)
const START_FRAME = 0;
// Maximum wait time after the first player joins for the second to connect (covers ticket TTL + buffer).
// If no match starts within the timeout, destroy the waiting room to prevent "got a ticket but never connected" room leaks.
const LAUNCH_TIMEOUT_MS = 35_000;

/** Join the specified side per ticket; match starts when both sides are present. Duplicate side is ignored. */
export function addPlayer(
  ctx: RoomCtx, conn: Connection, name: string, publicId: string, opponentTitle = '',
  decks?: { top: string[]; bottom: string[] }, opponentAvatarId = '', opponentSkins: string[] = [],
): void {
  if (ctx.phase >= RoomPhase.IN_MATCH) return; // match already started; new connections go through resume
  if (hasSide(ctx, conn.side)) return;
  ctx.slots.push({ side: conn.side, accountId: conn.accountId, name, publicId, opponentTitle, opponentAvatarId, opponentSkins, decks, conn });
  ctx.roster.push({ side: conn.side, accountId: conn.accountId });
  if (ctx.slots.length === 2) {
    launch(ctx);
  } else if (!ctx.launchTimer) {
    // First player arrived — start the empty-wait timeout; destroy the room if the second never connects.
    ctx.launchTimer = setTimeout(() => {
      ctx.launchTimer = null;
      if (ctx.phase < RoomPhase.IN_MATCH) destroy(ctx);
    }, LAUNCH_TIMEOUT_MS);
    ctx.launchTimer.unref?.();
  }
}

function launch(ctx: RoomCtx): void {
  if (ctx.launchTimer) {
    clearTimeout(ctx.launchTimer);
    ctx.launchTimer = null;
  }
  ctx.curFrame = START_FRAME;
  ctx.phase = RoomPhase.IN_MATCH;
  // Decks are identical across both slots (same ticket payload); use whichever slot has them.
  const decks = ctx.slots.find((s) => s.decks)?.decks;
  for (const s of ctx.slots) {
    s.conn?.send({
      case: 'match_start',
      roomId: ctx.roomId,
      mode: ctx.mode,
      seed: ctx.seed,
      startFrame: START_FRAME,
      localSide: s.side,
      opponentName: s.name, // slot.name is this slot's opponent name (sourced from the other ticket's ticket.opponent)
      opponentPublicId: s.publicId,
      ...(s.opponentTitle ? { opponentTitle: s.opponentTitle } : {}),
      ...(s.opponentAvatarId ? { opponentAvatarId: s.opponentAvatarId } : {}),
      ...(s.opponentSkins.length ? { opponentSkins: s.opponentSkins } : {}),
      ...(decks ? { topDeck: decks.top, bottomDeck: decks.bottom } : {}),
    });
  }
  startMetronome(ctx);
}

/** Explicit leave. During a match, treated as a forfeit (opponent wins). */
export function leave(ctx: RoomCtx, side: number): void {
  const slot = slotOfSide(ctx, side);
  if (!slot) return;
  if (ctx.phase === RoomPhase.IN_MATCH) {
    const peer = ctx.slots.find((s) => s.side !== side);
    log.info('explicit leave -> forfeit', { roomId: ctx.roomId, accountId: slot.accountId, side, curFrame: ctx.curFrame });
    void endMatch(ctx, { winnerSide: peer ? peer.side : -1, reason: 'disconnect', hashOk: true });
    return;
  }
  removeSlot(ctx, side);
}

export function onDisconnect(ctx: RoomCtx, side: number, closing: Connection): void {
  const slot = slotOfSide(ctx, side);
  if (!slot || slot.conn !== closing) return; // already replaced by a new connection; ignore
  slot.conn = null;

  if (ctx.phase !== RoomPhase.IN_MATCH) {
    removeSlot(ctx, side);
    return;
  }
  // This side already reported its own result before closing — a normal same-tick finish racing
  // its own socket teardown, not an abnormal drop. reportResult() will settle the match itself
  // (immediately if the peer already reported too, or once the peer catches up and reports) — no
  // grace timer/forfeit needed, and no false "mid-match disconnect" warning.
  if (ctx.results.has(side)) {
    removeSlot(ctx, side);
    return;
  }
  stopMetronome(ctx);
  const peer = ctx.slots.find((s) => s.side !== side && s.conn);
  log.warn('WS closed mid-match -> grace period started', {
    roomId: ctx.roomId,
    accountId: slot.accountId,
    side,
    curFrame: ctx.curFrame,
    graceMs: GRACE_MS,
  });
  peer?.conn?.send({ case: 'peer_dc', side, graceMs: GRACE_MS });
  ctx.graceTimer = setTimeout(() => {
    ctx.graceTimer = null;
    log.warn('grace period expired -> forfeit by disconnect', {
      roomId: ctx.roomId,
      accountId: slot.accountId,
      side,
      curFrame: ctx.curFrame,
    });
    void endMatch(ctx, {
      winnerSide: peer ? peer.side : -1,
      reason: 'disconnect',
      hashOk: true,
    });
  }, GRACE_MS);
  // Like launchTimer/metronome, don't hold the process open just for a grace window.
  ctx.graceTimer.unref?.();
}

/**
 * A new ticket connection claims a side that's already occupied — either the previous connection
 * is stale (new-device login evicting the old one) or this is the same device racing its own
 * reconnect. Evicts the stale socket immediately so it can't linger duplicating frames or block
 * the account from being taken over. During an active match, deliberately leaves `slot.conn`/
 * grace-timer/metronome alone: the client's follow-up conn_resume still drives resume() for that,
 * since it carries lastFrame needed to backfill the missed frame log correctly — rebinding here
 * first could let a metronome tick reach the new connection before its resync, if the stale socket
 * hadn't disconnected yet.
 * Pre-match (WAITING), there is no frame log to catch up on and the client never sends conn_resume
 * before match_start (lastFrame has no meaning yet) — so rebind immediately here (2026-08-04 fix).
 * Without this, `slot.conn` still pointed at the stale connection; once its close event eventually
 * fired, onDisconnect() saw an "abandoned" WAITING-phase slot and destroyed the room out from under
 * the very connection that had just replaced it, orphaning the reconnecting player with no room.
 */
export function takeover(ctx: RoomCtx, conn: Connection): void {
  const slot = slotOfSide(ctx, conn.side);
  if (!slot) return;
  const stale = slot.conn;
  if (stale && stale !== conn) stale.close(4409, 'replaced');
  if (ctx.phase !== RoomPhase.IN_MATCH) slot.conn = conn;
}

/** Reconnect: rebind connection + send conn_resync to catch up frames + resume metronome. */
export function resume(ctx: RoomCtx, conn: Connection, lastFrame: number): void {
  const slot = slotOfSide(ctx, conn.side);
  if (!slot || ctx.phase !== RoomPhase.IN_MATCH || ctx.settled) {
    conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no active match' });
    return;
  }
  slot.conn = conn;
  // Decks are identical across both slots (same ticket payload); use whichever slot has them —
  // mirrors launch()'s own lookup.
  const decks = ctx.slots.find((s) => s.decks)?.decks;
  conn.send({
    case: 'conn_resync',
    seed: ctx.seed,
    startFrame: START_FRAME,
    log: ctx.log.filter((f) => f.frame > lastFrame),
    curFrame: ctx.curFrame,
    // Login-reconnect-prompt cold resume (2026-08-08 fix): mirror launch()'s match_start payload
    // here too, so a client reconnecting from a freshly launched app (no matchInfo from this
    // process — see NetInputSource.onConnResync) can rebuild the engine from conn_resync alone.
    // Redundant, harmless no-op for a warm in-session reconnect that already has this info.
    roomId: ctx.roomId,
    mode: ctx.mode,
    localSide: slot.side,
    opponentName: slot.name,
    opponentPublicId: slot.publicId,
    ...(slot.opponentTitle ? { opponentTitle: slot.opponentTitle } : {}),
    ...(slot.opponentAvatarId ? { opponentAvatarId: slot.opponentAvatarId } : {}),
    ...(slot.opponentSkins.length ? { opponentSkins: slot.opponentSkins } : {}),
    ...(decks ? { topDeck: decks.top, bottomDeck: decks.bottom } : {}),
  });

  if (ctx.slots.every((s) => s.conn)) {
    if (ctx.graceTimer) {
      clearTimeout(ctx.graceTimer);
      ctx.graceTimer = null;
    }
    startMetronome(ctx);
  }
}

function removeSlot(ctx: RoomCtx, side: number): void {
  ctx.slots = ctx.slots.filter((s) => s.side !== side);
  if (ctx.slots.length === 0) destroy(ctx);
}
