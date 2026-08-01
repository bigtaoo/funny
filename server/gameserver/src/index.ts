// gameserver process bootstrap (S1-M2/M3): data-plane pure frame relay + ticket handshake + heartbeat.
// After slimming down, never connects to any database (M16).
// Reverse proxy forwards /ws to this process (SERVER_API.md §0).
import { createServer } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket, createLogger, internalHeaders, startHeartbeat } from '@nw/shared';

const log = createLogger('game');
import { loadGameEnv } from './config';
import { Connection } from './Connection';
import { RoomManager } from './RoomManager';
import { MetaReporter } from './metaReport';
import { decodeClient, MatchMode } from './proto/transport';

const HEARTBEAT_MS = 30_000; // Heartbeat probe: two consecutive missed pongs = dead connection
const REGISTER_HEARTBEAT_MS = 10_000; // Interval for reporting load to matchsvc

const CONN = Symbol('nwConn');
type WsWithConn = WebSocket & { [CONN]?: Connection };

async function registerWithMatchsvc(env: ReturnType<typeof loadGameEnv>): Promise<void> {
  if (!env.matchsvcInternalUrl || !env.publicWsUrl) return;
  const headers = { 'content-type': 'application/json', ...internalHeaders('gameserver', env.internalKey) };
  // Retry here, in this loop: heartbeat does NOT re-register (GameRegistry.heartbeat drops
  // unknown gameIds), so a lost register used to leave this instance permanently absent from
  // the registry (startup race vs matchsvc) with only the static fallback masking it.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${env.matchsvcInternalUrl}/mm/game/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ gameId: env.gameId, wsUrl: env.publicWsUrl, capacity: env.capacity }),
        signal: AbortSignal.timeout(5000),
      });
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
      if (res.ok) {
        console.log(`[gameserver] registered with matchsvc as ${env.gameId} (${env.publicWsUrl})`);
        return;
      }
      console.warn(`[gameserver] matchsvc register rejected (status ${res.status})`);
      if (res.status >= 400 && res.status < 500) return; // auth/config error — retrying won't help
    } catch (e) {
      console.warn('[gameserver] matchsvc register failed:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4))));
  }
}

function main(): void {
  const env = loadGameEnv();

  const reporter = new MetaReporter(env.metaBaseUrl, env.internalKey);
  const manager = new RoomManager({ report: (r) => reporter.report(r) });

  // Explicit HTTP server to handle WS upgrades + liveness probe: GET /health (no auth,
  // used by docker healthcheck / CI wait loops). All other non-upgrade requests return 426.
  // WS upgrades are still restricted to the /ws path (the path option is handled by ws).
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'gameserver' }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required');
  });
  // maxPayload: `ws` defaults to 100MB per frame with no cap otherwise. PlayerCommand frames (M12 opaque
  // bytes, never decoded here) are small per-turn inputs — 1MB is generous headroom while still bounding
  // memory/CPU an authenticated connection can force per message.
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1 << 20 });

  wss.on('connection', (ws: WebSocket, req) => {
    // Handshake auth: ?ticket=<matchsvc-signed ticket> (M18).
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const ticketStr = url.searchParams.get('ticket');
    let claims;
    try {
      // Signature verification only here; exp is enforced below for INITIAL joins only —
      // reconnects reuse the same ticket while the room is live, so expiry must not apply
      // to them (60s disconnect grace > 30s ticket TTL).
      claims = verifyTicket(ticketStr ?? '', { key: env.internalKey }, { ignoreExpiration: true });
    } catch (e) {
      log.warn('WS handshake rejected: invalid ticket', {
        hasTicket: !!ticketStr,
        err: (e as Error).message,
      });
      ws.close(4401, 'invalid ticket');
      return;
    }
    // Enforce exp on the initial handshake (comm-audit-internal-2026-07-28 P0-10): before this,
    // no layer ever checked exp — the ticket.ts contract said "RoomManager checks exp itself"
    // but it never did, so NW_TICKET_TTL_SEC was dead config and a leaked ticket could open a
    // fresh room indefinitely. An existing room means reconnect/takeover → expiry ignored.
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() && !manager.roomExists(claims.roomId)) {
      log.warn('WS handshake rejected: expired ticket for a room that no longer exists', {
        accountId: claims.accountId,
        roomId: claims.roomId,
      });
      ws.close(4401, 'ticket expired');
      return;
    }

    const conn = new Connection(claims.roomId, claims.side, claims.accountId, ws);
    conn.alive = true;
    (ws as WsWithConn)[CONN] = conn;

    const mode = claims.mode === 'ranked' ? MatchMode.RANKED : MatchMode.FRIENDLY;
    log.info('WS connected (ticket ok)', {
      accountId: claims.accountId,
      roomId: claims.roomId,
      side: claims.side,
      mode: claims.mode,
    });
    const ok = manager.join(conn, claims.opponent, claims.opponentPublicId ?? '', claims.seed, mode, claims.opponentTitle ?? '', claims.decks, claims.opponentAvatarId ?? '', claims.opponentSkins ?? []);
    if (!ok) {
      log.warn('join rejected: ticket room mismatch', { accountId: claims.accountId, roomId: claims.roomId });
      ws.close(4403, 'ticket room mismatch');
      return;
    }
    log.info('joined room', { accountId: claims.accountId, roomId: claims.roomId, side: claims.side });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      conn.alive = true;
      if (!isBinary) return;
      let msg;
      try {
        msg = decodeClient(new Uint8Array(data));
      } catch {
        return;
      }
      manager.handle(conn, msg);
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => manager.onClose(conn));
    ws.on('error', () => {
      /* close event will fire next */
    });
  });

  const conns = (): Connection[] =>
    [...wss.clients].map((ws) => (ws as WsWithConn)[CONN]).filter((c): c is Connection => !!c);
  const heartbeat = setInterval(() => {
    for (const conn of conns()) {
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
  }, HEARTBEAT_MS);

  // Register with matchsvc + periodically report load via heartbeat (optional in single-instance
  // deployments — matchsvc falls back to the static address).
  void registerWithMatchsvc(env);
  const registerTimer = setInterval(() => {
    if (!env.matchsvcInternalUrl) return;
    void fetch(`${env.matchsvcInternalUrl}/mm/game/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gameserver', env.internalKey) },
      body: JSON.stringify({ gameId: env.gameId, load: wss.clients.size }),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => res.body?.cancel())
      .catch(() => {
        /* retry on next cycle */
      });
  }, REGISTER_HEARTBEAT_MS);
  registerTimer.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(registerTimer);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    clearInterval(registerTimer);
    // Capture before destroyAll() wipes the rooms (login-reconnect-prompt, 2026-07-28): any room
    // still in progress at shutdown never gets an end-of-match report, so its players' cached
    // "resume your match?" flag would otherwise linger (bounded only by the 1h TTL) and offer to
    // reconnect into a room this restart just destroyed.
    const abandonedAccountIds = manager.activeAccountIds();
    manager.destroyAll();
    wss.close();
    http.close();
    // Give queued (failed/timed-out) match reports a bounded chance to reach meta —
    // the retry queue is in-memory only, so exiting immediately loses those settlements.
    void Promise.all([reporter.flush(10_000), reporter.abandon(abandonedAccountIds)]).finally(() =>
      process.exit(0),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  http.listen(env.port, env.host);
  console.log(`gameserver (data-plane relay) listening on ws://${env.host}:${env.port}/ws`);
  console.log(`meta report: ${env.metaBaseUrl ?? 'disabled'}; matchsvc: ${env.matchsvcInternalUrl ?? 'static-fallback'}`);
  startHeartbeat(log); // Liveness heartbeat: one info log every 5 minutes when idle
}

main();
