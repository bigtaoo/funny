// gateway internal HTTP (S1-M5, not exposed to the public internet): matchsvc pushes async events to gateway via /gw/push;
// gateway looks up the player socket by accountId and delivers the message. Auth: X-Internal-Key.
//
// (Before matchsvc was split into its own process, this server also handled game registration/heartbeat from gameserver — those two endpoints have since
//  been moved to matchsvc's own internal HTTP along with GameRegistry; gameserver now registers directly with matchsvc.)
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createLogger, type InternalAuthVerifier } from '@nw/shared';
import type { Gateway, JudgeArgs } from './Gateway';

const log = createLogger('gateway:internal');
import type { FrameCmdsOut } from './proto';
import type { PushMsg } from './matchsvcClient';

/** /gw/judge request body (sent by meta or worldsvc). Command bytes in frames are base64-encoded for safe JSON transport. */
interface JudgeReqBody {
  seed?: number;
  mode?: number;
  endFrame?: number;
  frames?: { frame: number; cmds: { side: number; commands: string }[] }[];
  exclude?: string[];
  /** PvE spot-check re-computation (PVE_INTEGRITY §8.6 L1). */
  levelId?: string;
  /** @deprecated S3-2 blueprint snapshot, replaced by unitLevels as of S12. */
  pveUpgrades?: Record<string, number>;
  /** S12 unit progression level snapshot (unitId→1..9). */
  unitLevels?: Record<string, number>;
  /** SLG siege defense config JSON string (S8-3b, sent by worldsvc). */
  defenseJson?: string;
}

/** Decode base64 frames → gateway-internal FrameCmdsOut (commands decoded back to Uint8Array). */
function decodeFrames(frames: JudgeReqBody['frames']): FrameCmdsOut[] {
  return (frames ?? []).map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({ side: c.side, commands: new Uint8Array(Buffer.from(c.commands, 'base64')) })),
  }));
}

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

export function startInternalHttp(
  opts: { host: string; port: number; internalAuth: InternalAuthVerifier },
  gateway: Gateway,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      // Liveness probe (no auth required): used by docker healthcheck / CI wait loops.
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'gateway' });
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
      try {
        if (req.method === 'POST' && req.url === '/gw/push') {
          const b = (await readJson(req)) as { accountId?: string; msg?: PushMsg; roomId?: string };
          if (!b.accountId || !b.msg) {
            send(res, 400, { ok: false, error: 'accountId and msg required' });
            return;
          }
          log.debug('recv /gw/push', { accountId: b.accountId, kind: b.msg.kind, roomId: b.roomId });
          gateway.push(b.accountId, b.msg, b.roomId);
          send(res, 200, { ok: true });
          return;
        }
        // Real-time stats aggregation (admin monitoring/sampling, OPS_DESIGN §4.1): current online connection count.
        if (req.method === 'GET' && req.url === '/internal/stats') {
          send(res, 200, gateway.stats());
          return;
        }
        // Online presence query (meta marks friend list online flags, SOC9): ?accounts=a,b,c → {[id]: bool}.
        if (req.method === 'GET' && req.url?.startsWith('/gw/presence')) {
          const u = new URL(req.url, 'http://localhost');
          const accounts = (u.searchParams.get('accounts') ?? '').split(',').filter(Boolean);
          send(res, 200, gateway.presenceOf(accounts));
          return;
        }
        // Friend relationship changed (notified by meta) → clear gateway friend cache; it will be re-fetched on the next broadcast/query.
        if (req.method === 'POST' && req.url === '/gw/social/invalidate') {
          const b = (await readJson(req)) as { accountId?: string };
          if (b.accountId) gateway.invalidateFriends(b.accountId);
          send(res, 200, { ok: true });
          return;
        }
        // Peer judge (Phase C): meta sends a match replay; gateway picks a judge to re-compute and blocks until returning the verdict.
        if (req.method === 'POST' && req.url === '/gw/judge') {
          const b = (await readJson(req)) as JudgeReqBody;
          const args: JudgeArgs = {
            seed: Number(b.seed ?? 0),
            mode: Number(b.mode ?? 0),
            endFrame: Number(b.endFrame ?? 0),
            frames: decodeFrames(b.frames),
            exclude: b.exclude ?? [],
            ...(b.levelId ? { levelId: b.levelId } : {}),
            ...(b.pveUpgrades ? { pveUpgrades: b.pveUpgrades } : {}),
            ...(b.unitLevels ? { unitLevels: b.unitLevels } : {}),
            ...(b.defenseJson ? { defenseJson: b.defenseJson } : {}),
          };
          // Returns JudgeResult directly (ok = whether the verdict succeeded; meta uses it to convict or void the match).
          const result = await gateway.judge(args);
          send(res, 200, result);
          return;
        }
        send(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        send(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
