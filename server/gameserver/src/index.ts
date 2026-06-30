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
  try {
    await fetch(`${env.matchsvcInternalUrl}/mm/game/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ gameId: env.gameId, wsUrl: env.publicWsUrl, capacity: env.capacity }),
    });
    console.log(`[gameserver] registered with matchsvc as ${env.gameId} (${env.publicWsUrl})`);
  } catch (e) {
    console.warn('[gameserver] matchsvc register failed (will retry via heartbeat):', (e as Error).message);
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
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    // Handshake auth: ?ticket=<matchsvc-signed ticket> (M18).
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const ticketStr = url.searchParams.get('ticket');
    let claims;
    try {
      // Signature verification only; exp constrains the initial connection — reconnects reuse
      // the same ticket and ignore expiry (an active room no longer checks exp).
      claims = verifyTicket(ticketStr ?? '', { key: env.internalKey }, { ignoreExpiration: true });
    } catch (e) {
      log.warn('WS handshake rejected: invalid ticket', {
        hasTicket: !!ticketStr,
        err: (e as Error).message,
      });
      ws.close(4401, 'invalid ticket');
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
    const ok = manager.join(conn, claims.opponent, claims.opponentPublicId ?? '', claims.seed, mode, claims.opponentTitle ?? '', claims.decks);
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
      body: JSON.stringify({ gameId: env.gameId, load: wss.clients.size, rooms: 0 }),
    }).catch(() => {
      /* retry on next cycle */
    });
  }, REGISTER_HEARTBEAT_MS);
  registerTimer.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(registerTimer);
  });

  const shutdown = (): void => {
    clearInterval(heartbeat);
    clearInterval(registerTimer);
    manager.destroyAll();
    wss.close();
    http.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  http.listen(env.port, env.host);
  console.log(`gameserver (data-plane relay) listening on ws://${env.host}:${env.port}/ws`);
  console.log(`meta report: ${env.metaBaseUrl ?? 'disabled'}; matchsvc: ${env.matchsvcInternalUrl ?? 'static-fallback'}`);
  startHeartbeat(log); // Liveness heartbeat: one info log every 5 minutes when idle
}

main();
