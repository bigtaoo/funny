// NetSession (S1-8, S1-M4) — online session orchestration. Under the three-channel
// architecture (M20), room/matchmaking uses the **gateway control-plane WS**, and lockstep
// play uses the **game data-plane WS**; these are two independent connections:
//
//   NetSession
//     ├── gatewayConn (control plane /gw?token=)  ── rooms/matchmaking room_*/createRanked, receives match_found
//     └── gameConn    (data plane ?ticket=)        ── lockstep cmd_submit/frame_batch (connects only after match_found)
//
// Lifetime: created once when the player first opens a friend room; survives across
// RoomScene → GameScene (gameConn's NetInputSource must continuously consume frame_batch
// while the engine is running). One match at a time; single-subscription per event is sufficient.
//
// On match_found{game_url, ticket} → connect gameConn with ticket → receive match_start
// (from game, derived from ticket) → NetInputSource.onMatchStart → app builds the engine.
// auth/save still go through meta REST, unchanged.

import type { AuthCredential, IPlatform } from '../platform/IPlatform';
import { NetClient, type NetState } from './NetClient';
import {
  MatchMode,
  type ChatMessagePush,
  type FriendPresence,
  type FriendRequestPush,
  type FriendUpdate,
  type MailNew,
  type MatchOver,
  type PeerDc,
  type RoomError,
  type RoomState,
  type ServerMsg,
  type MarchUpdate,
  type TileUpdate,
  type UnderAttack,
  type SiegeResult,
  type FamilyMsg,
  type SectMsg,
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
  /**
   * Ranked match timed out and fell back to an AI opponent (feature flag match_bot_fallback).
   * No gameConn / ticket; the app opens a local AI match (PvP-vs-AI) directly,
   * using the seed supplied by the server to keep it deterministic.
   */
  onMatchBot?(seed: number, opponentName: string, elo: number, difficulty: string): void;
  onNetState?(s: NetState): void;
  // —— Social real-time push (S6, gateway control-plane push). UI refreshes notification badges / online status / messages from these. ——
  onFriendPresence?(p: FriendPresence): void;
  onFriendRequest?(r: FriendRequestPush): void;
  onFriendUpdate?(u: FriendUpdate): void;
  onChatMessage?(m: ChatMessagePush): void;
  onMailNew?(m: MailNew): void;
  // —— SLG world map real-time push (S8, worldsvc → gateway control-plane push). WorldMapScene uses these for incremental updates. ——
  onMarchUpdate?(m: MarchUpdate): void;
  onTileUpdate?(t: TileUpdate): void;
  onUnderAttack?(u: UnderAttack): void;
  onSiegeResult?(s: SiegeResult): void;
  onFamilyMsg?(f: FamilyMsg): void;
  onSectMsg?(s: SectMsg): void;
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

  reportResult(stateHash: string, winnerSide: number, stats?: Record<string, number>): void {
    this.game?.reportResult(stateHash, winnerSide, stats);
  }

  getLocalSide(): number {
    return this.localSide;
  }

  // ── Routing ──────────────────────────────────────────────────────────────────

  /**
   * Token for the gateway handshake. Prefer the token the REST client already
   * holds (the *logged-in* account, from password login / persisted token) so
   * the room identity matches the player's real account — otherwise the gateway
   * would re-auth via the device credential and the player would show up as an
   * anonymous device account (wrong nickname / id). Only when there's no token
   * (truly anonymous) do we mint one from the device/wx credential.
   */
  private async freshToken(): Promise<string> {
    const existing = this.api.getToken();
    if (existing) return existing;
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
    } else if (msg.matchBot) {
      // Match timeout fallback to AI: skip the data plane, start a local AI match directly.
      log.info('match_bot', { seed: msg.matchBot.seed, opponent: msg.matchBot.opponentName });
      this.handlers.onMatchBot?.(
        msg.matchBot.seed,
        msg.matchBot.opponentName,
        msg.matchBot.elo,
        msg.matchBot.difficulty,
      );
    } else if (msg.judgeRequest) {
      // Phase C: the server asked us to recompute a desynced ranked match. Replay
      // it headlessly and report the verdict hash; this client is a neutral third
      // party (never one of the two players in that match).
      const r = msg.judgeRequest;
      const out = runJudge(r);
      this.gateway.sendJudgeVerdict(r.requestId, out.stateHash, out.winnerSide, out.ok, out.stars, out.statsJson);
    } else if (msg.friendPresence) {
      this.handlers.onFriendPresence?.(msg.friendPresence);
    } else if (msg.friendRequest) {
      log.info('friend_request', { from: msg.friendRequest.fromPublicId });
      this.handlers.onFriendRequest?.(msg.friendRequest);
    } else if (msg.friendUpdate) {
      this.handlers.onFriendUpdate?.(msg.friendUpdate);
    } else if (msg.chatMessage) {
      this.handlers.onChatMessage?.(msg.chatMessage);
    } else if (msg.mailNew) {
      this.handlers.onMailNew?.(msg.mailNew);
    } else if (msg.marchUpdate) {
      this.handlers.onMarchUpdate?.(msg.marchUpdate);
    } else if (msg.tileUpdate) {
      this.handlers.onTileUpdate?.(msg.tileUpdate);
    } else if (msg.underAttack) {
      this.handlers.onUnderAttack?.(msg.underAttack);
    } else if (msg.siegeResult) {
      this.handlers.onSiegeResult?.(msg.siegeResult);
    } else if (msg.familyMsg) {
      this.handlers.onFamilyMsg?.(msg.familyMsg);
    } else if (msg.sectMsg) {
      this.handlers.onSectMsg?.(msg.sectMsg);
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
    // Same ticket = a re-sent match_found for the *current* match → ignore.
    if (this.game && this.ticket === ticket) return;
    // A different ticket means a NEW match (e.g. queueing again after the last
    // one ended). The previous data-plane socket was never torn down — drop it
    // first, otherwise the stale conn blocks this match from ever connecting
    // (the rematch-can't-connect bug).
    if (this.game) {
      log.info('tearing down stale game conn before new match');
      this.game.disconnect();
      this.game = null;
    }
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
