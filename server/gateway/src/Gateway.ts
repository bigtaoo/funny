// Gateway control-plane WS service (M20, public-facing player endpoint). Thin connection layer:
//   • Handshake via ?token=<jwt> (reuses meta's JWT; extracts accountId and binds it to the connection);
//   • Maintains account → socket mapping (a new connection for the same account replaces the old one);
//   • Forwards client control-plane messages (room_create/join/ready/start/leave) to matchsvc (separate process, internal HTTP);
//   • Delivers events pushed back by matchsvc via /gw/push (room_state / match_found / room_error) to the corresponding socket.
//
// This service does not handle matchmaking, does not store rooms, and does not issue tickets — all of that lives in matchsvc (§8.1).
// Ranked enqueue fetches ELO from meta before joining the queue.
//
// Assembly shell (2026-08-10 split, ≤500-line convention, see claudedocs/server.md "单文件 500 行收敛" §拆分形态
// 优先级 — 独立类 + 组合): the class below used to hold ALL of this service's state and logic (896 lines).
// It now only constructs and wires five independent classes under `gateway/` and forwards its original public
// methods to them — no behavior changed, every external import path (`./Gateway`) is unchanged.
//   • connRegistry        — account→socket map, WS handshake/heartbeat/close, cross-instance kick, presence queries.
//   • presenceBroadcaster — friend online/offline broadcast (SOC9).
//   • matchCommands       — async matchmaking commands (ranked enqueue, room create/join, duel invite/respond).
//   • peerJudge           — Phase C peer-judge selection + verdict resolution.
//   • dispatcher          — per-connection rate limiting + the control-message switch.
// Each depends on its siblings only through the narrow interfaces in `gateway/types.ts`
// (ConnLookup/Push/MatchCommandsPort/PeerJudgePort) — this file is the only place that wires them together.
import type { JwtConfig } from '@nw/shared';
import type { MatchsvcClient, PushMsg } from './matchsvcClient';
import type { MetaClient } from './metaClient';
import type { SocialsvcClient } from './socialsvcClient';
import type { GatewaySubscriber } from './redis';
import { ConnRegistry } from './gateway/connRegistry';
import { PresenceBroadcaster } from './gateway/presenceBroadcaster';
import { MatchCommands } from './gateway/matchCommands';
import { PeerJudgeService } from './gateway/peerJudge';
import { Dispatcher } from './gateway/dispatcher';
import type { JudgeArgs, JudgeResult } from './gateway/types';

export type { JudgeArgs, JudgeResult };

export class Gateway {
  private readonly connRegistry: ConnRegistry;
  private readonly presence: PresenceBroadcaster;
  private readonly matchCommands: MatchCommands;
  private readonly peerJudge: PeerJudgeService;
  private readonly dispatcher: Dispatcher;

  constructor(
    opts: { host: string; port: number; rateLimitTight?: number; rateLimitStandard?: number },
    jwt: JwtConfig,
    matchsvc: MatchsvcClient,
    meta: MetaClient,
    socialsvc?: SocialsvcClient,
  ) {
    // connRegistry is constructed first (it owns the account→socket map every other layer reads through
    // ConnLookup) but its callbacks reference the sibling layers below — safe because none of those
    // callbacks FIRE until a real WS connection arrives, well after this constructor returns.
    this.connRegistry = new ConnRegistry(opts, {
      jwt,
      matchsvc,
      onOnline: (accountId) => void this.presence.notifyOnline(accountId),
      onOffline: (accountId) => void this.presence.notifyOffline(accountId),
      onSocketClosed: (accountId) => this.peerJudge.cancelPendingFor(accountId),
      onMessage: (accountId, msg) => this.dispatcher.handle(accountId, msg),
    });
    this.presence = new PresenceBroadcaster({ conns: this.connRegistry, push: this.connRegistry.push, meta, socialsvc });
    this.matchCommands = new MatchCommands({ conns: this.connRegistry, push: this.connRegistry.push, meta, matchsvc });
    this.peerJudge = new PeerJudgeService({ conns: this.connRegistry });
    this.dispatcher = new Dispatcher(
      { rateLimitTight: opts.rateLimitTight, rateLimitStandard: opts.rateLimitStandard },
      { conns: this.connRegistry, push: this.connRegistry.push, matchsvc, matchCommands: this.matchCommands, peerJudge: this.peerJudge },
    );
  }

  /** matchsvc → player: looks up the socket by accountId and pushes a message. Drops silently if the player is offline. */
  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => this.connRegistry.push(accountId, msg, roomId);

  /** Redis pub/sub fan-out (SOC9 / §8.4) — see connRegistry.routeBroadcast for the full doc. */
  readonly routeBroadcast = (recipients: string[], msg: PushMsg, roomId?: string): void =>
    this.connRegistry.routeBroadcast(recipients, msg, roomId);

  /** Wired by index.ts once Redis connects — lets onConnection() notify sibling instances of a same-account takeover. */
  setKickPublisher(fn: (accountId: string, originInstanceId: string, connSeq: number) => void): void {
    this.connRegistry.setKickPublisher(fn);
  }

  /** Wired by index.ts once Redis connects: connRegistry gets cross-instance presence, and the dispatcher's
   *  rate limiters upgrade from the in-process fallback to the Redis-backed implementation (using the
   *  subscriber's dedicated rateLimitClient connection) so the per-accountId limits are precise across
   *  gateway instances instead of each instance keeping its own independent count. */
  setPresenceStore(store: GatewaySubscriber): void {
    this.connRegistry.setPresenceStore(store);
    this.dispatcher.upgradeRateLimiters(store.rateLimitClient);
  }

  /** Cross-instance account takeover (2026-07-18, §8.4) — see connRegistry.routeKick for the full doc. */
  readonly routeKick = (accountId: string, originInstanceId: string, remoteConnSeq: number): void =>
    this.connRegistry.routeKick(accountId, originInstanceId, remoteConnSeq);

  /** Real-time stats aggregation (admin GET /internal/stats, OPS_DESIGN §4.1/§8): current number of online connections. */
  readonly stats = (): { online: number } => this.connRegistry.stats();

  /** Batch online-status query (used by meta to mark the online flag on friend lists) — see connRegistry.presenceOf. */
  readonly presenceOf = (accountIds: string[]): Promise<Record<string, boolean>> => this.connRegistry.presenceOf(accountIds);

  /** Friend relationship changed (notified by meta) → clear cache; re-fetched on next broadcast/query. */
  readonly invalidateFriends = (accountId: string): void => this.presence.invalidateFriends(accountId);

  close(): void {
    this.connRegistry.close();
  }

  /**
   * Called by meta (via /gw/judge): picks an eligible idle online player to headlessly re-compute the match and report the final-state hash.
   * No eligible candidate / timeout / re-computation failed → {ok:false}; meta voids the result (no penalty).
   */
  judge(args: JudgeArgs): Promise<JudgeResult> {
    return this.peerJudge.judge(args);
  }
}
