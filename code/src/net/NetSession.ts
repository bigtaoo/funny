// NetSession (S1-8, S1-M4) — 联机会话编排。三通道架构（M20）下，房间/匹配走 **gateway
// 控制面 WS**，锁步对战走 **game 数据面 WS**，二者是两条独立连接：
//
//   NetSession
//     ├── gatewayConn (控制面 /gw?token=)  ── 房间/匹配 room_*/createRanked，收 match_found
//     └── gameConn    (数据面 ?ticket=)     ── 锁步 cmd_submit/frame_batch（收 match_found 后才连）
//
// Lifetime: 玩家首次开好友房时建一次，跨 RoomScene → GameScene 存活（gameConn 的
// NetInputSource 须在引擎播放期间持续吃 frame_batch）。一次一局，每事件单订阅足够。
//
// 收 match_found{game_url, ticket} → 用 ticket 连 gameConn → 收 match_start（来自 game，
// 取自 ticket）→ NetInputSource.onMatchStart → app 建引擎。auth/save 仍走 meta REST，不变。

import type { AuthCredential, IPlatform } from '../platform/IPlatform';
import { NetClient, type NetState } from './NetClient';
import {
  MatchMode,
  type MatchOver,
  type PeerDc,
  type RoomError,
  type RoomState,
  type ServerMsg,
} from './proto/transport';
import { NetInputSource, type MatchStartInfo } from '../game';
import type { ApiClient } from './ApiClient';

export interface NetSessionHandlers {
  onRoomState?(s: RoomState): void;
  onRoomError?(e: RoomError): void;
  onPeerDc?(p: PeerDc): void;
  onMatchOver?(m: MatchOver): void;
  /** Fired once the data-plane confirms match_start — app builds the engine here. */
  onMatchStart?(info: MatchStartInfo): void;
  onNetState?(s: NetState): void;
}

export class NetSession {
  /** Control plane: rooms / matchmaking. Always-on while the player is in the room flow. */
  readonly gateway: NetClient;
  /** Data plane: lockstep. Built lazily once match_found arrives. */
  private game: NetClient | null = null;
  readonly input: NetInputSource;

  handlers: NetSessionHandlers = {};

  private roomId = '';
  private localSide = -1;
  /** Stored match ticket — reused verbatim on game-plane reconnect. */
  private ticket = '';

  constructor(
    private readonly platform: IPlatform,
    /** gateway control-plane WS endpoint (/gw). */
    private readonly gatewayUrl: string,
    private readonly api: ApiClient,
    private readonly getCredential: () => Promise<AuthCredential>,
  ) {
    this.input = new NetInputSource(
      { submitCmd: (bytes) => this.game?.submitCmd(bytes) },
      {
        onMatchStart: (info) => {
          this.roomId = info.roomId;
          this.localSide = info.localSide;
          this.handlers.onMatchStart?.(info);
        },
      },
    );

    this.gateway = new NetClient(platform, {
      url: gatewayUrl,
      tokenProvider: () => this.freshToken(),
      handlers: {
        onServerMsg: (msg) => this.routeControl(msg),
        // Pre-match the room overlay tracks the control plane; in-match the game
        // plane takes over (its onStateChange overrides).
        onStateChange: (s) => {
          if (!this.game) this.handlers.onNetState?.(s);
        },
        // gateway reconnect: server re-sends room_state for our accountId (no
        // client action needed — GATEWAY_DESIGN §7 default).
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  connect(): void {
    this.gateway.connect();
  }

  /** Leave the room/queue and tear down both sockets. */
  close(): void {
    this.gateway.leaveRoom();
    this.gateway.disconnect();
    this.game?.disconnect();
    this.game = null;
    this.roomId = '';
    this.localSide = -1;
    this.ticket = '';
  }

  // ── Room actions (control plane) ──────────────────────────────────────────────

  createRoom(): void {
    this.gateway.createRoom(MatchMode.FRIENDLY);
  }
  joinRoom(code: string): void {
    this.gateway.joinRoom(code);
  }
  setReady(ready: boolean): void {
    this.gateway.setReady(ready);
  }
  startMatch(): void {
    this.gateway.startMatch();
  }
  /** Enter the ranked queue (server pairs by ELO + auto-starts → match_found). */
  createRanked(): void {
    this.gateway.createRoom(MatchMode.RANKED);
  }
  cancelQueue(): void {
    this.gateway.leaveRoom();
  }

  // ── Match actions (data plane) ────────────────────────────────────────────────

  reportResult(stateHash: string, winnerSide: number): void {
    this.game?.reportResult(stateHash, winnerSide);
  }

  getLocalSide(): number {
    return this.localSide;
  }

  // ── Routing ──────────────────────────────────────────────────────────────────

  /** Re-auth on every (re)connect: device/wx auth is idempotent → stable accountId + fresh JWT. */
  private async freshToken(): Promise<string> {
    const res = await this.api.auth(await this.getCredential());
    return res.token;
  }

  /** Control-plane messages (gateway): rooms + match_found. */
  private routeControl(msg: ServerMsg): void {
    if (msg.roomState) this.handlers.onRoomState?.(msg.roomState);
    else if (msg.roomError) this.handlers.onRoomError?.(msg.roomError);
    else if (msg.matchFound) this.connectGame(msg.matchFound.gameUrl, msg.matchFound.ticket);
  }

  /** Data-plane messages (game): lockstep + match_start/peer_dc/match_over. */
  private routeData(msg: ServerMsg): void {
    // The input source consumes match_start / frame_batch / conn_resync; feed it all.
    this.input.handleServerMsg(msg);
    if (msg.peerDc) this.handlers.onPeerDc?.(msg.peerDc);
    else if (msg.matchOver) this.handlers.onMatchOver?.(msg.matchOver);
    // match_start is surfaced via NetInputSource.onMatchStart (above).
  }

  /** Got match_found → connect the data-plane WS with the signed ticket. */
  private connectGame(gameUrl: string, ticket: string): void {
    if (this.game) return; // already connected for this match
    this.ticket = ticket;
    this.game = new NetClient(this.platform, {
      url: gameUrl,
      queryParam: 'ticket',
      tokenProvider: () => Promise.resolve(this.ticket),
      handlers: {
        onServerMsg: (m) => this.routeData(m),
        onStateChange: (s) => this.handlers.onNetState?.(s),
        // Mid-match game-plane reconnect → ask the server to replay frames past
        // our watermark and resume the metronome (S1-4).
        onReconnect: () => {
          if (this.roomId) this.game?.resume(this.roomId, this.input.resumeFrame());
        },
      },
    });
    this.game.connect();
  }
}
