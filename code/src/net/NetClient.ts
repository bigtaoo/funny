// gameserver WS 客户端（S1-6）：连接 / 重连 / 协议编解码。
// 平台 socket 由 IPlatform.connectSocket 提供（Web/CrazyGames=WebSocket，微信=wx）。
// 协议用 C-2 生成的 ts-proto 编解码（src/net/proto/transport.ts）。
//
// 职责边界：本类只管「可靠的双向消息管道」。锁步播放（消费 frame_batch、
// 推进引擎、缓冲）在 NetInputSource（S1-7）；房间 UI 在 RoomScene（S1-8）。
// 重连后只通知上层（onReconnect），由上层决定发 conn_resume 续局（S1-4）。
import type { IGameSocket, IPlatform, SocketHandlers } from '../platform/IPlatform';
import { Envelope, type ClientMsg, type MatchMode, type ServerMsg } from './proto/transport';

export type NetState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetClientHandlers {
  /** 收到一条服务器消息（已解码 oneof）。 */
  onServerMsg(msg: ServerMsg): void;
  /** 连接状态变化（UI 提示用）。 */
  onStateChange?(state: NetState): void;
  /** 掉线重连成功（socket 重新 open，非首次连接）。上层据此发 conn_resume。 */
  onReconnect?(): void;
}

export interface NetClientOptions {
  /** WS 端点（不含 query）。gateway 控制面 = /gw；game 数据面 = match_found.game_url。 */
  url: string;
  /**
   * 取新鲜凭证（每次连接/重连都调）。gateway 用 JWT（?token=），game 用 ticket（?ticket=）。
   * 重连复用同一票据（ticket exp 仅约束首连，game 验签放过已活房间的过期票据）。
   */
  tokenProvider: () => Promise<string>;
  /** 握手 query 参数名：gateway = 'token'（默认），game 数据面 = 'ticket'。 */
  queryParam?: string;
  handlers: NetClientHandlers;
  /** 重连退避（ms），用尽后保持末值。默认 [500,1000,2000,4000,8000]。 */
  backoffMs?: number[];
  /** 应用层心跳间隔（ms），保活 + 让服务端看到流量。默认 25000；0 = 关。 */
  pingIntervalMs?: number;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000];

export class NetClient {
  private socket: IGameSocket | null = null;
  private state: NetState = 'idle';
  /** 连接代次：每次 connect/disconnect 自增，丢弃旧 socket 的滞后回调（微信 socket 无法摘回调）。 */
  private gen = 0;
  private intentional = false; // 主动断开，不重连
  private everOpened = false; // 区分首次 open 与重连 open
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly backoff: number[];
  private readonly pingIntervalMs: number;

  constructor(
    private readonly platform: IPlatform,
    private readonly opt: NetClientOptions,
  ) {
    this.backoff = opt.backoffMs ?? DEFAULT_BACKOFF;
    this.pingIntervalMs = opt.pingIntervalMs ?? 25_000;
  }

  getState(): NetState {
    return this.state;
  }

  /** 建立连接（幂等：已连/连接中则忽略）。 */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'open') return;
    this.intentional = false;
    this.attempt = 0;
    this.everOpened = false;
    void this.openSocket();
  }

  /** 主动断开（不触发重连）。 */
  disconnect(): void {
    this.intentional = true;
    this.gen++; // 作废当前 socket 的所有回调
    this.clearTimers();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setState('closed');
  }

  // ── 发送（仅 open 态发；未连时丢弃，上层不应在未连时出牌）──────────
  createRoom(mode: MatchMode): void {
    this.sendClient({ roomCreate: { mode } });
  }
  joinRoom(code: string): void {
    this.sendClient({ roomJoin: { code } });
  }
  setReady(ready: boolean): void {
    this.sendClient({ roomReady: { ready } });
  }
  startMatch(): void {
    this.sendClient({ roomStart: {} });
  }
  leaveRoom(): void {
    this.sendClient({ roomLeave: {} });
  }
  /** 出牌指令（已用 game.proto 编码的 PlayerCommands bytes，opaque）。 */
  submitCmd(commands: Uint8Array): void {
    this.sendClient({ cmdSubmit: { commands } });
  }
  reportResult(stateHash: string, winnerSide: number): void {
    this.sendClient({ matchResult: { stateHash, winnerSide } });
  }
  /** 重连续局（onReconnect 后调）。 */
  resume(roomId: string, lastFrame: number): void {
    this.sendClient({ connResume: { roomId, lastFrame } });
  }
  ping(): void {
    this.sendClient({ ping: {} });
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async openSocket(): Promise<void> {
    const gen = this.gen;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    let token: string;
    try {
      token = await this.opt.tokenProvider();
    } catch (e) {
      if (gen !== this.gen) return; // 期间被 disconnect/重置
      this.scheduleReconnect();
      return;
    }
    if (gen !== this.gen) return;

    const url = `${this.opt.url}?${this.opt.queryParam ?? 'token'}=${encodeURIComponent(token)}`;
    const handlers: SocketHandlers = {
      onOpen: () => {
        if (gen !== this.gen) return;
        this.attempt = 0;
        this.setState('open');
        this.startPing();
        if (this.everOpened) this.opt.handlers.onReconnect?.();
        this.everOpened = true;
      },
      onMessage: (data) => {
        if (gen !== this.gen) return;
        let env: Envelope;
        try {
          env = Envelope.decode(data);
        } catch {
          return; // 坏帧丢弃
        }
        if (env.server) this.opt.handlers.onServerMsg(env.server);
      },
      onClose: () => {
        if (gen !== this.gen || this.intentional) return;
        this.stopPing();
        this.socket = null;
        this.scheduleReconnect();
      },
      onError: () => {
        // 浏览器 error 后会跟 close；微信可能只有 error。统一交给 close 驱动重连；
        // 若长时间无 close（极少），心跳缺失也不致命（上层 grace 内会暂停）。
      },
    };
    this.socket = this.platform.connectSocket(url, handlers);
  }

  private scheduleReconnect(): void {
    if (this.intentional) return;
    this.setState('reconnecting');
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)]!;
    this.attempt++;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => void this.openSocket(), delay);
  }

  private sendClient(client: ClientMsg): void {
    if (!this.socket || this.state !== 'open') return;
    const bytes = Envelope.encode(Envelope.fromPartial({ client })).finish();
    this.socket.send(bytes);
  }

  private setState(s: NetState): void {
    if (this.state === s) return;
    this.state = s;
    this.opt.handlers.onStateChange?.(s);
  }

  private startPing(): void {
    if (this.pingIntervalMs <= 0) return;
    this.stopPing();
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
  }
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  private clearTimers(): void {
    this.clearReconnect();
    this.stopPing();
  }
}
