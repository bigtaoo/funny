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
  /** PvE 抽检复算（PVE_INTEGRITY §8.6 L1）：非空 → 裁判按战役模式复算该关。 */
  levelId?: string;
  /** 服务器权威蓝图快照（升级等级），保证 PvE 复算确定性。 */
  pveUpgrades?: Record<string, number>;
  /** SLG 围攻防守 config JSON 字符串（S8-3b）：非空 → 裁判按 siege 模式复算。 */
  defenseJson?: string;
}
/** 裁判结果（回给 meta）。ok=false：无候选 / 超时 / 复算失败。 */
export interface JudgeResult {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  /** PvE 复算得到的星数（PVE_INTEGRITY §8.6 L1）。 */
  stars?: number;
  /** PvE 喂入（S9-3b）：复算出的玩家本局成就计数 JSON；PvP/siege 恒空。 */
  statsJson?: string;
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
  /** 好友列表缓存（accountId → 好友 accountId[]）；好友变更经 /gw/social/invalidate 清。 */
  private readonly friendsCache = new Map<string, string[]>();
  /** publicId 缓存（accountId → publicId）；presence 广播复用，避免每次问 meta。 */
  private readonly publicIdCache = new Map<string, string>();

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

  /**
   * Redis pub/sub 扇出（SOC9 / §8.4）：worldsvc 把「一条消息 + 收件人列表」发到 Redis，
   * 每个 gateway 实例收到后只向本机在线的收件人推送（离线/不在本机 → 跳过）。
   * 这样 worldsvc 对 ≤900 人宗门只发一条，扇出成本落在各 gateway 的本地 socket 写。
   */
  readonly routeBroadcast = (recipients: string[], msg: PushMsg): void => {
    for (const accountId of recipients) {
      const conn = this.conns.get(accountId);
      if (conn && conn.ws.readyState === conn.ws.OPEN) this.push(accountId, msg);
    }
  };

  /** 实时态聚合（admin GET /internal/stats，OPS_DESIGN §4.1/§8）：当前在线连接数。 */
  readonly stats = (): { online: number } => ({ online: this.conns.size });

  /** 批量在线态查询（meta 标好友列表 online flag）。accountId → 是否有活跃连接。 */
  readonly presenceOf = (accountIds: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of accountIds) {
      const conn = this.conns.get(id);
      out[id] = !!conn && conn.ws.readyState === conn.ws.OPEN;
    }
    return out;
  };

  /** 好友关系变更（meta 通知）→ 清缓存，下次广播/查询重拉。 */
  readonly invalidateFriends = (accountId: string): void => {
    this.friendsCache.delete(accountId);
  };

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
  }

  // ───────────────────────── 好友在线态广播（SOC9）─────────────────────────

  private async friendsOf(accountId: string): Promise<string[]> {
    const cached = this.friendsCache.get(accountId);
    if (cached) return cached;
    const friends = await this.meta.getFriends(accountId);
    this.friendsCache.set(accountId, friends);
    return friends;
  }

  private async publicIdOf(accountId: string): Promise<string> {
    const cached = this.publicIdCache.get(accountId);
    if (cached !== undefined) return cached;
    const p = await this.meta.getProfile(accountId);
    const pid = p.publicId ?? '';
    this.publicIdCache.set(accountId, pid);
    return pid;
  }

  /**
   * 上/下线广播：向当前在线的好友 push 我的 friend_presence；上线时另给我推一份在线好友快照。
   * meta 不可用（无好友来源）则跳过——presence 是好友功能，不影响联机主线。
   */
  private async broadcastPresence(accountId: string, online: boolean): Promise<void> {
    if (!this.meta.available) return;
    const [friends, myPid] = await Promise.all([
      this.friendsOf(accountId),
      this.publicIdOf(accountId),
    ]);
    if (!myPid) return;
    for (const fid of friends) {
      const fConn = this.conns.get(fid);
      if (!fConn || fConn.ws.readyState !== fConn.ws.OPEN) continue;
      this.push(fid, { kind: 'friend_presence', publicId: myPid, online });
      // 上线时回送：该在线好友的在线态给刚上线的我（下线时我已断开，无需回送）。
      if (online) {
        const fPid = await this.publicIdOf(fid);
        if (fPid) this.push(accountId, { kind: 'friend_presence', publicId: fPid, online: true });
      }
    }
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
    // 好友在线态广播（SOC9）：通知在线好友我上线 + 给我推一份在线好友快照。
    void this.broadcastPresence(accountId, true);

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
        // 通知在线好友我下线（不给自己推，conn 已删）。
        void this.broadcastPresence(accountId, false);
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
                  stars: msg.stars,
                  statsJson: msg.statsJson,
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
            levelId: args.levelId ?? '',
            pveUpgrades: args.pveUpgrades ?? {},
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
    case 'friend_presence':
      return { case: 'friend_presence', publicId: msg.publicId, online: msg.online };
    case 'friend_request':
      return {
        case: 'friend_request',
        requestId: msg.requestId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        message: msg.message,
      };
    case 'friend_update':
      return { case: 'friend_update', publicId: msg.publicId, added: msg.added };
    case 'chat_message':
      return {
        case: 'chat_message',
        convId: msg.convId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'mail_new':
      return { case: 'mail_new', mailId: msg.mailId, hasAttachment: msg.hasAttachment };
    case 'march_update':
      return {
        case: 'march_update',
        marchId: msg.marchId,
        marchKind: msg.marchKind,
        fromTile: msg.fromTile,
        toTile: msg.toTile,
        arriveAt: msg.arriveAt,
        status: msg.status,
      };
    case 'tile_update':
      return {
        case: 'tile_update',
        tileId: msg.tileId,
        type: msg.type,
        level: msg.level,
        ownerId: msg.ownerId,
        familyId: msg.familyId,
        protectedUntil: msg.protectedUntil,
      };
    case 'under_attack':
      return {
        case: 'under_attack',
        tile: msg.tile,
        attackerName: msg.attackerName,
        attackerPublicId: msg.attackerPublicId,
        arriveAt: msg.arriveAt,
        troopsHint: msg.troopsHint,
      };
    case 'siege_result':
      return {
        case: 'siege_result',
        siegeId: msg.siegeId,
        tile: msg.tile,
        outcome: msg.outcome,
        lootSummary: msg.lootSummary,
        replayRef: msg.replayRef,
      };
    case 'family_msg':
      return {
        case: 'family_msg',
        familyId: msg.familyId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'sect_msg':
      return {
        case: 'sect_msg',
        sectId: msg.sectId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
  }
}
