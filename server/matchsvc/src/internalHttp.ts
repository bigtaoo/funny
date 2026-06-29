// matchsvc internal HTTP (S1-M5, not exposed to the public internet). Two categories of callers, both authenticated via X-Internal-Key:
//   • gateway (control-plane): forwards player control commands → /mm/room/* · /mm/queue/* · /mm/conn/*;
//   • gameserver (data-plane): startup registration + periodic heartbeat → /mm/game/register · /mm/game/heartbeat.
//
// Uses node:http (matchsvc does not use fastify). Commands are "process on receipt; push async events back via GatewayClient",
// so responses only return {ok:true} (no room state in the HTTP response).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createLogger, type InternalAuthVerifier } from '@nw/shared';
import type { Matchsvc } from './Matchsvc';

const log = createLogger('matchsvc:internal');

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);

export function startInternalHttp(
  opts: { host: string; port: number; internalAuth: InternalAuthVerifier },
  svc: Matchsvc,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      // Liveness probe (no auth required): used by docker healthcheck / CI wait.
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'matchsvc' });
        return;
      }
      if (!opts.internalAuth.verify(req.headers).ok) {
        log.warn('internal request rejected: bad X-Internal-Key', {
          url: req.url,
          caller: req.headers['x-internal-caller'],
        });
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      // Real-time state aggregation (admin monitoring/sampling, OPS_DESIGN §4.1): queue / room / game instances.
      if (req.method === 'GET' && req.url === '/internal/stats') {
        send(res, 200, svc.stats());
        return;
      }
      if (req.method !== 'POST') {
        send(res, 404, { ok: false, error: 'not found' });
        return;
      }
      try {
        const b = await readJson(req);
        // Game heartbeat fires every 10s and is noisy → debug; all other commands use info.
        if (req.url === '/mm/game/heartbeat') log.debug(`recv ${req.url}`, { gameId: b.gameId });
        else log.info(`recv ${req.url}`, { accountId: b.accountId, code: b.code, gameId: b.gameId });
        switch (req.url) {
          // —— gateway control commands ——
          case '/mm/room/create':
            svc.roomCreate(str(b.accountId), str(b.name), str(b.publicId));
            break;
          case '/mm/room/join':
            svc.roomJoin(str(b.accountId), str(b.name), str(b.publicId), str(b.code));
            break;
          case '/mm/room/ready':
            svc.roomReady(str(b.accountId), Boolean(b.ready));
            break;
          case '/mm/room/start':
            svc.roomStart(str(b.accountId));
            break;
          case '/mm/room/leave':
            svc.roomLeave(str(b.accountId));
            break;
          case '/mm/queue/enqueue':
            svc.enqueue(str(b.accountId), str(b.name), str(b.publicId), num(b.elo, 1000), str(b.equippedTitle), str(b.platform));
            break;
          case '/mm/conn/connected':
            svc.onConnected(str(b.accountId));
            break;
          case '/mm/conn/disconnected':
            svc.onDisconnected(str(b.accountId));
            break;
          // —— gameserver registration / heartbeat ——
          case '/mm/game/register':
            if (!b.gameId || !b.wsUrl) {
              send(res, 400, { ok: false, error: 'gameId and wsUrl required' });
              return;
            }
            svc.registerGame(str(b.gameId), str(b.wsUrl), num(b.capacity, 100));
            break;
          case '/mm/game/heartbeat':
            if (!b.gameId) {
              send(res, 400, { ok: false, error: 'gameId required' });
              return;
            }
            svc.gameHeartbeat(str(b.gameId), num(b.load, 0), num(b.rooms, 0));
            break;
          default:
            send(res, 404, { ok: false, error: 'not found' });
            return;
        }
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
