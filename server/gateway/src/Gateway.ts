// gateway 控制面 WS 服务（M20，玩家公开门面）。薄连接层：
//   • 握手 ?token=<jwt>（复用 meta 的 JWT，解出 accountId 绑定连接）；
//   • 维护 account → socket 映射（同账号新连顶替旧连）；
//   • 把客户端控制面消息（room_create/join/ready/start/leave）转发进程内 matchsvc；
//   • 把 matchsvc 回调事件（room_state / match_found / room_error）推回对应 socket。
//
// 它不做匹配、不存房间、不签 ticket——全在 matchsvc（§8.1）。ranked 入队前向 meta 取 ELO。
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken, type JwtConfig } from '@nw/shared';
import { decodeClient, encodeServer, MatchMode, type PlayerSlotOut, type ServerMsg } from './proto';
import type { Matchsvc, PushMsg } from './matchsvc/Matchsvc';
import type { MetaClient } from './metaClient';

const HEARTBEAT_MS = 30_000;

interface GwConn {
  accountId: string;
  ws: WebSocket;
  alive: boolean;
}

/** 玩家展示名（gateway 只有 accountId，沿用 gameserver 旧约定取前 12 位）。 */
function displayName(accountId: string): string {
  return accountId.slice(0, 12);
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, GwConn>(); // accountId → 活跃连接
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    opts: { host: string; port: number },
    private readonly jwt: JwtConfig,
    private readonly matchsvc: Matchsvc,
    private readonly meta: MetaClient,
  ) {
    this.wss = new WebSocketServer({ host: opts.host, port: opts.port, path: '/gw' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url, req.headers.host));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(this.heartbeat));
  }

  /** matchsvc → 玩家：据 accountId 找 socket 推消息。离线则丢弃。 */
  readonly push = (accountId: string, msg: PushMsg): void => {
    const conn = this.conns.get(accountId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(encodeServer(toServerMsg(msg)));
    } catch {
      /* close 收口 */
    }
  };

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
  }

  // ───────────────────────── 连接 ─────────────────────────

  private onConnection(ws: WebSocket, url: string | undefined, host: string | undefined): void {
    const u = new URL(url ?? '', `ws://${host ?? 'localhost'}`);
    const token = u.searchParams.get('token');
    let accountId: string;
    try {
      accountId = verifyToken(token ?? '', this.jwt);
    } catch {
      ws.close(4401, 'unauthenticated');
      return;
    }

    // 同账号顶替旧连（双开 / 残连）。
    const prev = this.conns.get(accountId);
    if (prev && prev.ws !== ws) {
      try {
        prev.ws.close(4409, 'replaced');
      } catch {
        /* ignore */
      }
    }
    const conn: GwConn = { accountId, ws, alive: true };
    this.conns.set(accountId, conn);
    this.matchsvc.onConnected(accountId);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      conn.alive = true;
      if (!isBinary) return;
      let msg;
      try {
        msg = decodeClient(new Uint8Array(data));
      } catch {
        return;
      }
      this.handle(accountId, msg);
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => {
      if (this.conns.get(accountId) === conn) {
        this.conns.delete(accountId);
        this.matchsvc.onDisconnected(accountId);
      }
    });
    ws.on('error', () => {
      /* close 随后触发 */
    });
  }

  private handle(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    switch (msg.case) {
      case 'room_create':
        if (msg.mode === MatchMode.RANKED) {
          void this.enqueueRanked(accountId);
        } else {
          this.matchsvc.roomCreate(accountId, displayName(accountId));
        }
        break;
      case 'room_join':
        this.matchsvc.roomJoin(accountId, displayName(accountId), msg.code);
        break;
      case 'room_ready':
        this.matchsvc.roomReady(accountId, msg.ready);
        break;
      case 'room_start':
        this.matchsvc.roomStart(accountId);
        break;
      case 'room_leave':
        this.matchsvc.roomLeave(accountId);
        break;
      case 'ping':
        this.sendPong(accountId);
        break;
      case 'unknown':
        break;
    }
  }

  /** ranked 入队：先向 meta 取 ELO（matchsvc 保持 DB-free），再入队。 */
  private async enqueueRanked(accountId: string): Promise<void> {
    if (!this.meta.available) {
      this.push(accountId, {
        kind: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked requires server storage',
      });
      return;
    }
    const elo = await this.meta.getElo(accountId);
    // await 期间可能掉线 → 仅在仍在线时入队。
    if (!this.conns.has(accountId)) return;
    this.matchsvc.enqueue(accountId, displayName(accountId), elo);
  }

  private sendPong(accountId: string): void {
    const conn = this.conns.get(accountId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(encodeServer({ case: 'pong' }));
    } catch {
      /* ignore */
    }
  }

  private sweep(): void {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
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
}

// matchsvc PushMsg（proto 无关）→ 控制面 ServerMsg。
function toServerMsg(msg: PushMsg): ServerMsg {
  switch (msg.kind) {
    case 'room_state':
      return {
        case: 'room_state',
        code: msg.code,
        players: msg.players as PlayerSlotOut[],
        phase: msg.phase,
      };
    case 'match_found':
      return { case: 'match_found', gameUrl: msg.gameUrl, ticket: msg.ticket };
    case 'room_error':
      return { case: 'room_error', code: msg.code, message: msg.message };
  }
}
