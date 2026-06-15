// gateway 控制面 WS 服务（M20，玩家公开门面）。薄连接层：
//   • 握手 ?token=<jwt>（复用 meta 的 JWT，解出 accountId 绑定连接）；
//   • 维护 account → socket 映射（同账号新连顶替旧连）；
//   • 把客户端控制面消息（room_create/join/ready/start/leave）转发给 matchsvc（独立进程，内部 HTTP）；
//   • 把 matchsvc 经 /gw/push 回推的事件（room_state / match_found / room_error）推回对应 socket。
//
// 它不做匹配、不存房间、不签 ticket——全在 matchsvc（§8.1）。ranked 入队前向 meta 取 ELO。
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken, createLogger, type JwtConfig } from '@nw/shared';

const log = createLogger('gateway');
import {
  decodeClient,
  encodeServer,
  MatchMode,
  type FrameCmdsOut,
  type PlayerSlotOut,
  type ServerMsg,
} from './proto';
import type { MatchsvcClient, PushMsg } from './matchsvcClient';
import type { MetaClient } from './metaClient';

const HEARTBEAT_MS = 30_000;
/** 裁判复算 + 回报的等待上限（含网络往返 + 客户端跑完整局）。 */
const JUDGE_TIMEOUT_MS = 20_000;

interface GwConn {
  accountId: string;
  ws: WebSocket;
  alive: boolean;
  /** 本机能否承担无头复算裁决（client_caps 上报）。 */
  canJudge: boolean;
}

/** meta → gateway 裁判请求（内部 HTTP /gw/judge）。 */
export interface JudgeArgs {
  seed: number;
  mode: number;
  endFrame: number;
  frames: FrameCmdsOut[];
  /** 参赛双方 accountId——不可自己裁自己。 */
  exclude: string[];
}
/** 裁判结果（回给 meta）。ok=false：无候选 / 超时 / 复算失败。 */
export interface JudgeResult {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  judgeAccountId?: string;
}

interface PendingJudge {
  resolve: (r: JudgeResult) => void;
  accountId: string;
  timer: NodeJS.Timeout;
}

/** 玩家展示名（gateway 只有 accountId，沿用 gameserver 旧约定取前 12 位）。 */
function displayName(accountId: string): string {
  return accountId.slice(0, 12);
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, GwConn>(); // accountId → 活跃连接
  private readonly heartbeat: NodeJS.Timeout;
  /** 在途裁判请求（requestId → pending）。verdict 到达或超时即清。 */
  private readonly pendingJudges = new Map<string, PendingJudge>();
  private judgeSeq = 0;

  constructor(
    opts: { host: string; port: number },
    private readonly jwt: JwtConfig,
    private readonly matchsvc: MatchsvcClient,
    private readonly meta: MetaClient,
  ) {
    this.wss = new WebSocketServer({ host: opts.host, port: opts.port, path: '/gw' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url, req.headers.host));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(this.heartbeat));
  }

  /** matchsvc → 玩家：据 accountId 找 socket 推消息。离线则丢弃。 */
  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => {
    const conn = this.conns.get(accountId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      log.warn('push dropped: recipient offline', { accountId, kind: msg.kind, roomId });
      return;
    }
    log.info(`push -> ${msg.kind}`, {
      accountId,
      roomId,
      ...(msg.kind === 'room_state' ? { code: msg.code, phase: msg.phase, players: msg.players.length } : {}),
      ...(msg.kind === 'match_found' ? { gameUrl: msg.gameUrl } : {}),
      ...(msg.kind === 'room_error' ? { code: msg.code, message: msg.message } : {}),
    });
    try {
      conn.ws.send(encodeServer(toServerMsg(msg)));
    } catch (e) {
      log.warn('push send failed', { accountId, err: (e as Error).message });
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
    } catch (e) {
      log.warn('WS handshake rejected: invalid token', {
        hasToken: !!token,
        err: (e as Error).message,
      });
      ws.close(4401, 'unauthenticated');
      return;
    }

    // 同账号顶替旧连（双开 / 残连）。
    const prev = this.conns.get(accountId);
    if (prev && prev.ws !== ws) {
      log.info('replacing existing connection (same account)', { accountId });
      try {
        prev.ws.close(4409, 'replaced');
      } catch {
        /* ignore */
      }
    }
    const conn: GwConn = { accountId, ws, alive: true, canJudge: false };
    this.conns.set(accountId, conn);
    log.info('WS connected', { accountId, online: this.conns.size });
    this.matchsvc.connected(accountId);

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
    ws.on('close', (code: number) => {
      if (this.conns.get(accountId) === conn) {
        this.conns.delete(accountId);
        log.info('WS closed', { accountId, code, online: this.conns.size });
        this.matchsvc.disconnected(accountId);
      }
      // 该账号若正担任裁判 → 立即作废其在途请求（不必等超时）。
      for (const [id, p] of this.pendingJudges) {
        if (p.accountId !== accountId) continue;
        clearTimeout(p.timer);
        this.pendingJudges.delete(id);
        p.resolve({ ok: false });
      }
    });
    ws.on('error', () => {
      /* close 随后触发 */
    });
  }

  private handle(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    // ping 太频繁，单独 debug；其余控制命令 info 级（联调主线）。
    if (msg.case !== 'ping') log.info(`recv ${msg.case}`, { accountId });
    switch (msg.case) {
      case 'room_create':
        if (msg.mode === MatchMode.RANKED) {
          log.info('-> ranked enqueue', { accountId });
          void this.enqueueRanked(accountId);
        } else {
          log.info('-> matchsvc roomCreate', { accountId });
          void this.resolveProfile(accountId).then(({ name, publicId }) =>
            this.matchsvc.roomCreate(accountId, name, publicId),
          );
        }
        break;
      case 'room_join': {
        const code = msg.code;
        log.info('-> matchsvc roomJoin', { accountId, code });
        void this.resolveProfile(accountId).then(({ name, publicId }) =>
          this.matchsvc.roomJoin(accountId, name, publicId, code),
        );
        break;
      }
      case 'room_ready':
        this.matchsvc.roomReady(accountId, msg.ready);
        break;
      case 'room_start':
        this.matchsvc.roomStart(accountId);
        break;
      case 'room_leave':
        this.matchsvc.roomLeave(accountId);
        break;
      case 'client_caps': {
        const conn = this.conns.get(accountId);
        if (conn) conn.canJudge = msg.canJudge;
        break;
      }
      case 'judge_verdict': {
        const pending = this.pendingJudges.get(msg.requestId);
        // 只接受被指派的裁判回报（防别的玩家伪造 verdict 抢答）。
        if (pending && pending.accountId === accountId) {
          clearTimeout(pending.timer);
          this.pendingJudges.delete(msg.requestId);
          pending.resolve(
            msg.ok
              ? {
                  ok: true,
                  stateHash: msg.stateHash,
                  winnerSide: msg.winnerSide,
                  judgeAccountId: accountId,
                }
              : { ok: false },
          );
        }
        break;
      }
      case 'ping':
        this.sendPong(accountId);
        break;
      case 'unknown':
        break;
    }
  }

  // ───────────────────────── 对等裁判（Phase C）─────────────────────────

  /**
   * meta 调用（经 /gw/judge）：挑一名高配空闲在线玩家无头复算该局，回报终局 hash。
   * 无合格候选 / 超时 / 复算失败 → {ok:false}，meta 退回作废（不定罪）。
   */
  judge(args: JudgeArgs): Promise<JudgeResult> {
    const candidate = this.pickJudge(args.exclude);
    if (!candidate) return Promise.resolve({ ok: false });

    const requestId = `j${++this.judgeSeq}:${Date.now()}`;
    return new Promise<JudgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJudges.delete(requestId);
        resolve({ ok: false });
      }, JUDGE_TIMEOUT_MS);
      timer.unref?.();
      this.pendingJudges.set(requestId, { resolve, accountId: candidate.accountId, timer });
      try {
        candidate.ws.send(
          encodeServer({
            case: 'judge_request',
            requestId,
            seed: args.seed,
            mode: args.mode,
            endFrame: args.endFrame,
            frames: args.frames,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pendingJudges.delete(requestId);
        resolve({ ok: false });
      }
    });
  }

  /** 挑一名 canJudge 且不在 exclude 中的在线玩家（任一即可，单裁判）。 */
  private pickJudge(exclude: string[]): GwConn | null {
    for (const conn of this.conns.values()) {
      if (!conn.canJudge) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (exclude.includes(conn.accountId)) continue;
      return conn;
    }
    return null;
  }

  /** ranked 入队：先向 meta 取 ELO（matchsvc 保持 DB-free），再入队。 */
  private async enqueueRanked(accountId: string): Promise<void> {
    if (!this.meta.available) {
      log.warn('ranked rejected: meta unavailable (no ELO source)', { accountId });
      this.push(accountId, {
        kind: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked requires server storage',
      });
      return;
    }
    const elo = await this.meta.getElo(accountId);
    // await 期间可能掉线 → 仅在仍在线时入队。
    if (!this.conns.has(accountId)) {
      log.warn('ranked enqueue aborted: account dropped during ELO fetch', { accountId });
      return;
    }
    const { name, publicId } = await this.resolveProfile(accountId);
    if (!this.conns.has(accountId)) return;
    log.info('-> matchsvc enqueue', { accountId, elo });
    this.matchsvc.enqueue(accountId, name, publicId, elo);
  }

  /**
   * 玩家展示资料：向 meta 取真实昵称 + 9 位数字公开 id。meta 不可用 / 无资料 →
   * 名字退回 accountId 前 12 位、publicId 空串（房间仍可建，只是名字不友好）。
   */
  private async resolveProfile(accountId: string): Promise<{ name: string; publicId: string }> {
    const p = await this.meta.getProfile(accountId);
    return { name: p.displayName || displayName(accountId), publicId: p.publicId ?? '' };
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
