// gateway 内部 HTTP（S1-M5，不暴露公网）：matchsvc 把异步事件经 /gw/push 推回 gateway，
// gateway 据 accountId 找到玩家 socket 下发。鉴权：X-Internal-Key。
//
// （拆 matchsvc 为独立进程前，这里曾接 gameserver 的 game 注册/心跳——那两个端点已随
//  GameRegistry 迁到 matchsvc 自己的内部 HTTP，gameserver 现直接注册到 matchsvc。）
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createLogger } from '@nw/shared';
import type { Gateway, JudgeArgs } from './Gateway';

const log = createLogger('gateway:internal');
import type { FrameCmdsOut } from './proto';
import type { PushMsg } from './matchsvcClient';

/** /gw/judge 请求体（meta 或 worldsvc 发来）。frames 的 command bytes 用 base64 传输（JSON 安全）。 */
interface JudgeReqBody {
  seed?: number;
  mode?: number;
  endFrame?: number;
  frames?: { frame: number; cmds: { side: number; commands: string }[] }[];
  exclude?: string[];
  /** PvE 抽检复算（PVE_INTEGRITY §8.6 L1）。 */
  levelId?: string;
  pveUpgrades?: Record<string, number>;
  /** SLG 围攻防守 config JSON 字符串（S8-3b，worldsvc 发来）。 */
  defenseJson?: string;
}

/** base64 帧 → gateway 内部 FrameCmdsOut（commands 解回 Uint8Array）。 */
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
  opts: { host: string; port: number; internalKey: string },
  gateway: Gateway,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      // 存活探针（无需 X-Internal-Key）：docker healthcheck / CI 等待用。
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'gateway' });
        return;
      }
      if (req.headers['x-internal-key'] !== opts.internalKey) {
        log.warn('internal request rejected: bad X-Internal-Key', { url: req.url });
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
        // 实时态聚合（admin 监控/采样，OPS_DESIGN §4.1）：当前在线连接数。
        if (req.method === 'GET' && req.url === '/internal/stats') {
          send(res, 200, gateway.stats());
          return;
        }
        // 在线态查询（meta 标好友列表 online flag，SOC9）：?accounts=a,b,c → {[id]: bool}。
        if (req.method === 'GET' && req.url?.startsWith('/gw/presence')) {
          const u = new URL(req.url, 'http://localhost');
          const accounts = (u.searchParams.get('accounts') ?? '').split(',').filter(Boolean);
          send(res, 200, gateway.presenceOf(accounts));
          return;
        }
        // 好友关系变更（meta 通知）→ 清 gateway 好友缓存，下次广播/查询重拉。
        if (req.method === 'POST' && req.url === '/gw/social/invalidate') {
          const b = (await readJson(req)) as { accountId?: string };
          if (b.accountId) gateway.invalidateFriends(b.accountId);
          send(res, 200, { ok: true });
          return;
        }
        // 对等裁判（Phase C）：meta 发来一局录像，gateway 挑裁判复算并阻塞返回裁决。
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
            ...(b.defenseJson ? { defenseJson: b.defenseJson } : {}),
          };
          // 直接回 JudgeResult（ok = 裁决是否成功；meta 据此定罪或作废）。
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
