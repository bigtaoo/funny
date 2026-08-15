// gameserver process bootstrap (S1-M2/M3): data-plane pure frame relay + ticket handshake + heartbeat.
// After slimming down, never connects to any database (M16).
// Reverse proxy forwards /ws to this process (SERVER_API.md §0).
//
// Business logic lives in connectionHandler.ts (ticket admission / message routing / heartbeat
// sweep), httpHealth.ts (the plain HTTP surface), matchsvcRegistration.ts (register + load
// heartbeat), and lifecycle.ts (shutdown sequencing) — all pure functions/classes over minimal
// interfaces, so they're unit-tested without a real socket/process. This file is left as thin
// wiring only: env load, real http+WebSocketServer construction, and gluing the pieces together.
import { createServer } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger, startHeartbeat } from '@nw/shared';

const log = createLogger('game');
import { loadGameEnv } from './config';
import { RoomManager } from './RoomManager';
import { MetaReporter } from './metaReport';
import { wireConnection, getConnections, sweepHeartbeat } from './connectionHandler';
import { handleHttpRequest } from './httpHealth';
import { createShutdownHandler } from './lifecycle';
import { registerWithMatchsvc, reportLoadHeartbeat } from './matchsvcRegistration';

const HEARTBEAT_MS = 30_000; // Heartbeat probe: two consecutive missed pongs = dead connection
const REGISTER_HEARTBEAT_MS = 10_000; // Interval for reporting load to matchsvc

function main(): void {
  const env = loadGameEnv();

  const reporter = new MetaReporter(env.metaBaseUrl, env.internalKey);
  const manager = new RoomManager({ report: (r) => reporter.report(r) });

  // Explicit HTTP server to handle WS upgrades + liveness probe: GET /health (no auth,
  // used by docker healthcheck / CI wait loops). All other non-upgrade requests return 426.
  // WS upgrades are still restricted to the /ws path (the path option is handled by ws).
  const http = createServer(handleHttpRequest);
  // maxPayload: `ws` defaults to 100MB per frame with no cap otherwise. PlayerCommand frames (M12 opaque
  // bytes, never decoded here) are small per-turn inputs — 1MB is generous headroom while still bounding
  // memory/CPU an authenticated connection can force per message.
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1 << 20 });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    wireConnection(ws, url, env, manager);
  });

  const heartbeat = setInterval(() => sweepHeartbeat(getConnections(wss.clients)), HEARTBEAT_MS);

  // Register with matchsvc + periodically report load via heartbeat (optional in single-instance
  // deployments — matchsvc falls back to the static address).
  void registerWithMatchsvc(env);
  const registerTimer = setInterval(() => void reportLoadHeartbeat(env, wss.clients.size), REGISTER_HEARTBEAT_MS);
  registerTimer.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(registerTimer);
  });

  const shutdown = createShutdownHandler({ manager, reporter, wss, http, timers: [heartbeat, registerTimer] });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  http.listen(env.port, env.host);
  console.log(`gameserver (data-plane relay) listening on ws://${env.host}:${env.port}/ws`);
  console.log(`meta report: ${env.metaBaseUrl ?? 'disabled'}; matchsvc: ${env.matchsvcInternalUrl ?? 'static-fallback'}`);
  startHeartbeat(log); // Liveness heartbeat: one info log every 5 minutes when idle
}

main();
