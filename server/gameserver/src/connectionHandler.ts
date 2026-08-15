// Ticket-handshake connection admission + per-connection message routing + heartbeat sweep,
// extracted from index.ts's `wss.on('connection', ...)` closure (S1-M2 slim gameserver) so this
// logic is unit-testable without a real network socket — same fake-object technique already used
// by RoomManager/Room's tests (a minimal object satisfying the handful of `WebSocket` members each
// function actually touches, cast through `as unknown as WebSocket`). index.ts is left as thin
// wiring: real `http`/`WebSocketServer` construction + calling these functions.
import type { WebSocket } from 'ws';
import { verifyTicket, createLogger } from '@nw/shared';
import type { GameEnv } from './config';
import { Connection } from './Connection';
import { RoomManager } from './RoomManager';
import { decodeClient, MatchMode } from './proto/transport';

const log = createLogger('game');

/**
 * Handshake auth: ?ticket=<matchsvc-signed ticket> (M18). Verifies the signature, enforces `exp`
 * on the initial join only (an existing room means reconnect/takeover — reconnects reuse the same
 * ticket while the room is live, so expiry must not apply to them: 60s disconnect grace > 30s
 * ticket TTL), then asks the RoomManager to seat this connection.
 *
 * Closes `ws` and returns null on any rejection — callers must not wire message/pong/close
 * handlers when this returns null (there is no Connection to route them to).
 */
export function resolveConnection(
  url: URL,
  ws: WebSocket,
  env: Pick<GameEnv, 'internalKey'>,
  manager: RoomManager,
): Connection | null {
  const ticketStr = url.searchParams.get('ticket');
  let claims;
  try {
    claims = verifyTicket(ticketStr ?? '', { key: env.internalKey }, { ignoreExpiration: true });
  } catch (e) {
    log.warn('WS handshake rejected: invalid ticket', {
      hasTicket: !!ticketStr,
      err: (e as Error).message,
    });
    ws.close(4401, 'invalid ticket');
    return null;
  }
  // comm-audit-internal-2026-07-28 P0-10: before this, no layer ever checked exp — an existing
  // room means reconnect/takeover, so expiry is skipped in that case only.
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() && !manager.roomExists(claims.roomId)) {
    log.warn('WS handshake rejected: expired ticket for a room that no longer exists', {
      accountId: claims.accountId,
      roomId: claims.roomId,
    });
    ws.close(4401, 'ticket expired');
    return null;
  }

  const conn = new Connection(claims.roomId, claims.side, claims.accountId, ws);
  conn.alive = true;

  const mode = claims.mode === 'ranked' ? MatchMode.RANKED : MatchMode.FRIENDLY;
  log.info('WS connected (ticket ok)', {
    accountId: claims.accountId,
    roomId: claims.roomId,
    side: claims.side,
    mode: claims.mode,
  });
  const ok = manager.join(
    conn,
    claims.opponent,
    claims.opponentPublicId ?? '',
    claims.seed,
    mode,
    claims.opponentTitle ?? '',
    claims.decks,
    claims.opponentAvatarId ?? '',
    claims.opponentSkins ?? [],
  );
  if (!ok) {
    log.warn('join rejected: ticket room mismatch', { accountId: claims.accountId, roomId: claims.roomId });
    ws.close(4403, 'ticket room mismatch');
    return null;
  }
  log.info('joined room', { accountId: claims.accountId, roomId: claims.roomId, side: claims.side });
  return conn;
}

/**
 * Routes one incoming WS frame to the room (or refreshes the heartbeat and drops it if it's a
 * text frame). PlayerCommand frames are opaque bytes (M12): decode failures are dropped silently
 * rather than closing the connection — a single malformed frame should not kill the match.
 */
export function routeMessage(conn: Connection, manager: RoomManager, data: Buffer, isBinary: boolean): void {
  conn.alive = true;
  if (!isBinary) return;
  let msg;
  try {
    msg = decodeClient(new Uint8Array(data));
  } catch {
    return;
  }
  manager.handle(conn, msg);
}

const CONN = Symbol('nwConn');
type WsWithConn = WebSocket & { [CONN]?: Connection };

/**
 * Full per-socket wiring for a just-accepted WS connection: runs the ticket handshake
 * (resolveConnection) and, on success, tags `ws` with its Connection (via a private symbol so
 * heartbeat sweeps can recover it from `wss.clients` later — see getConnections) and attaches
 * message/pong/close/error handlers. Returns null (already closed by resolveConnection) without
 * attaching anything when the handshake is rejected.
 */
export function wireConnection(
  ws: WebSocket,
  url: URL,
  env: Pick<GameEnv, 'internalKey'>,
  manager: RoomManager,
): Connection | null {
  const conn = resolveConnection(url, ws, env, manager);
  if (!conn) return null;
  (ws as WsWithConn)[CONN] = conn;

  ws.on('message', (data: Buffer, isBinary: boolean) => routeMessage(conn, manager, data, isBinary));
  ws.on('pong', () => {
    conn.alive = true;
  });
  ws.on('close', () => manager.onClose(conn));
  ws.on('error', () => {
    /* close event will fire next */
  });
  return conn;
}

/** Recovers every live Connection tagged onto a WebSocketServer's current client set (heartbeat sweeps). */
export function getConnections(clients: Iterable<WebSocket>): Connection[] {
  return [...clients].map((ws) => (ws as WsWithConn)[CONN]).filter((c): c is Connection => !!c);
}

/**
 * Heartbeat watchdog sweep (one tick = one call): any connection that missed two consecutive
 * pongs (still `alive === false` from the previous sweep) is terminated; everyone else is marked
 * not-alive and pinged, so the NEXT sweep can tell who answered.
 */
export function sweepHeartbeat(connections: Iterable<Connection>): void {
  for (const conn of connections) {
    if (!conn.alive) {
      log.warn('heartbeat missed 2 consecutive pongs -> terminating connection', {
        accountId: conn.accountId,
        roomId: conn.roomId,
        side: conn.side,
      });
      conn.ws.terminate();
      continue;
    }
    conn.alive = false;
    try {
      conn.ws.ping();
    } catch {
      /* ignore */
    }
  }
}
