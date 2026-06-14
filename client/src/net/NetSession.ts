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
import { runJudge } from './judgeRunner';
import { netLog } from './log';
import type { ApiClient } from './ApiClient';

const log = netLog('session');

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
      tag: 'gateway',
      tokenProvider: () => this.freshToken(),
      handlers: {
        onServerMsg: (msg) => this.routeControl(msg),
        // Pre-match the room overlay tracks the control plane; in-match the game
        // plane takes over (its onStateChange overrides).
        onStateChange: (s) => {
          // Advertise judge capability whenever the control plane (re)opens so the
          // server can pick us as a peer judge for desynced ranked matches (Phase C).
          if (s === 'open') this.gateway.sendClientCaps(this.canJudge);
          if (!this.game) this.handlers.onNetState?.(s);
        },
        // gateway reconnect: server re-sends room_state for our accountId (no
        // client action needed — GATEWAY_DESIGN §7 default).
      },
    });
  }

  /**
   * Whether this device should volunteer as a peer judge. The recompute runs a
   * full headless match, so gate it on a reasonably capable host; unknown → yes
   * (the run is bounded and only requested on rare desyncs).
   */
  private get canJudge(): boolean {
    const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)
      ?.hardwareConcurrency;
    return typeof cores === 'number' ? cores >= 4 : true;
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

  /** Control-plane messages (gateway): rooms + match_found + peer-judge requests. */
  private routeControl(msg: ServerMsg): void {
    if (msg.roomState) {
      log.info('room_state', {
        code: msg.roomState.code,
        phase: msg.roomState.phase,
        players: msg.roomState.players.length,
      });
      this.handlers.onRoomState?.(msg.roomState);
    } else if (msg.roomError) {
      log.error('room_error', { code: msg.roomError.code, message: msg.roomError.message });
      this.handlers.onRoomError?.(msg.roomError);
    } else if (msg.matchFound) {
      log.info('match_found', { gameUrl: msg.matchFound.gameUrl });
      this.connectGame(msg.matchFound.gameUrl, msg.matchFound.ticket);
    } else if (msg.judgeRequest) {
      // Phase C: the server asked us to recompute a desynced ranked match. Replay
      // it headlessly and report the verdict hash; this client is a neutral third
      // party (never one of the two players in that match).
      const r = msg.judgeRequest;
      const out = runJudge(r);
      this.gateway.sendJudgeVerdict(r.requestId, out.stateHash, out.winnerSide, out.ok);
    }
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
    log.info('connecting data plane (game)', { gameUrl });
    this.ticket = ticket;
    this.game = new NetClient(this.platform, {
      url: gameUrl,
      tag: 'game',
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
