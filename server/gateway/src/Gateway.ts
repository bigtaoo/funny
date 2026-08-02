// Gateway control-plane WS service (M20, public-facing player endpoint). Thin connection layer:
//   • Handshake via ?token=<jwt> (reuses meta's JWT; extracts accountId and binds it to the connection);
//   • Maintains account → socket mapping (a new connection for the same account replaces the old one);
//   • Forwards client control-plane messages (room_create/join/ready/start/leave) to matchsvc (separate process, internal HTTP);
//   • Delivers events pushed back by matchsvc via /gw/push (room_state / match_found / room_error) to the corresponding socket.
//
// This service does not handle matchmaking, does not store rooms, and does not issue tickets — all of that lives in matchsvc (§8.1).
// Ranked enqueue fetches ELO from meta before joining the queue.
import { randomUUID } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  verifyToken,
  createLogger,
  validatePvpDeck,
  defaultPvpDeck,
  createRateLimiter,
  type JwtConfig,
  type RateLimiter,
} from '@nw/shared';

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
import type { SocialsvcClient } from './socialsvcClient';
import type { GatewaySubscriber } from './redis';

const HEARTBEAT_MS = 30_000;
/** Maximum wait time for judge re-computation + report (includes network round-trip + client running the full match). */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * Per-connection control-message rate limiting (SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4): before this,
 * `handle()` dispatched every control message unconditionally — a scripted client could hammer room_create/
 * duel_invite as fast as the socket allows, spamming matchsvc and, for duel_invite, spamming *other* players
 * with invites. Two tiers, both keyed by accountId (reusing @nw/shared's createRateLimiter, same
 * in-process/Redis-backed pair as metaserver's auth/telemetry/save limiters):
 *   - TIGHT: creates state or notifies another player (room_create/room_join/duel_invite) — the more
 *     attractive abuse target, so a stricter cap than metaserver telemetry's 30/min (NW_AUTH_RATE_LIMIT-style
 *     env override below).
 *   - STANDARD: acts on state the player already owns (duel_respond/room_ready/room_leave/room_start) —
 *     same or a bit looser, since there's no third party to spam and the actions are more "clicky".
 * judge_verdict/client_caps/ping stay unlimited (ping is the hottest path; judge_verdict is a trusted
 * peer-judge report, not an abuse surface — see pickJudge's uniform-random selection).
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Production values are read from env by config.ts (NW_GW_RATE_LIMIT_TIGHT/NW_GW_RATE_LIMIT_STANDARD,
 *  loadGatewayEnv) and passed in via the constructor opts below; these are just the fallback when a caller
 *  (tests, or a future embedder) doesn't pass one. */
const DEFAULT_RATE_LIMIT_TIGHT = 10;
const DEFAULT_RATE_LIMIT_STANDARD = 20;

type RateLimitTier = 'tight' | 'standard';
/** ClientMsg.case values gated by the TIGHT tier. */
const TIGHT_CASES = new Set(['room_create', 'room_join', 'duel_invite']);
/** ClientMsg.case values gated by the STANDARD tier. */
const STANDARD_CASES = new Set(['duel_respond', 'room_ready', 'room_leave', 'room_start']);

interface GwConn {
  accountId: string;
  ws: WebSocket;
  alive: boolean;
  /** Whether this client is capable of performing headless re-computation judging (reported via client_caps). */
  canJudge: boolean;
}

/** meta → gateway judge request (internal HTTP /gw/judge). */
export interface JudgeArgs {
  seed: number;
  mode: number;
  endFrame: number;
  frames: FrameCmdsOut[];
  /** accountIds of both match participants — a player cannot judge their own match. */
  exclude: string[];
  /** PvE spot-check re-computation (PVE_INTEGRITY §8.6 L1): if non-empty, the judge re-runs the specified campaign level. */
  levelId?: string;
  /** SLG siege defense config JSON string (S8-3b): if non-empty, the judge re-runs in siege mode. */
  defenseJson?: string;
  /** CC-1 Hero Roster snapshot (2026-07-26 fix, PVE_INTEGRITY §9): JSON of Record<string, CardInstance>, server-authoritative, ensures deterministic PvE/siege re-computation using the player's real card levels. */
  cardInstancesJson?: string;
  /** JSON of Record<string, EquipmentInstance>, paired with cardInstancesJson. */
  equipmentInvJson?: string;
  /** Ranked PvP deck restriction (PVP_LOADOUT §6.2): the two real match clients' decks, needed for a deterministic re-simulation. */
  decks?: { top: string[]; bottom: string[] };
}
/** Judge result (returned to meta). ok=false: no eligible candidate / timeout / re-computation failed. */
export interface JudgeResult {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  /** Stars obtained from PvE re-computation (PVE_INTEGRITY §8.6 L1). */
  stars?: number;
  /** PvE feed-in (S9-3b): JSON of the player's per-match achievement stat counts from re-computation; always empty for PvP/siege. */
  statsJson?: string;
  judgeAccountId?: string;
}

interface PendingJudge {
  resolve: (r: JudgeResult) => void;
  accountId: string;
  timer: NodeJS.Timeout;
}

/** Player display name (gateway only has accountId; follows the gameserver's legacy convention of using the first 12 characters). */
function displayName(accountId: string): string {
  return accountId.slice(0, 12);
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, GwConn>(); // accountId → active connection
  private readonly heartbeat: NodeJS.Timeout;
  /** Stable per-process id (2026-07-18): tags this instance's own kick broadcasts so it can ignore
   *  its own echo instead of evicting the very connection it just accepted (see onConnection). */
  private readonly instanceId = randomUUID();
  /** Set once Redis connects (index.ts); null in single-instance/no-Redis deployments, where the
   *  local eviction in onConnection() already fully covers same-account takeover. */
  private kickPublisher: ((accountId: string, originInstanceId: string) => void) | null = null;
  /** Set once Redis connects (index.ts, same subscriber as kickPublisher above); null = presenceOf only
   *  ever sees this instance's own connections (correct for today's single-instance deployment). */
  private presenceStore: GatewaySubscriber | null = null;
  /** In-flight judge requests (requestId → pending). Cleared when a verdict arrives or on timeout. */
  private readonly pendingJudges = new Map<string, PendingJudge>();
  private judgeSeq = 0;
  /** Friends-list cache (accountId → friend accountId[]); invalidated by friend changes via /gw/social/invalidate. */
  private readonly friendsCache = new Map<string, string[]>();
  /** publicId cache (accountId → publicId); reused for presence broadcasts to avoid querying meta on every event. */
  private readonly publicIdCache = new Map<string, string>();
  /** Configured limits (kept so setPresenceStore can rebuild both limiters against a Redis client once one connects). */
  private readonly tightLimit: number;
  private readonly standardLimit: number;
  /** In-process fallback until (if ever) setPresenceStore wires a Redis client — same "start local, upgrade
   *  to precise-across-instances once Redis is up" shape as metaserver's createRateLimiter call sites. */
  private rateLimiters: Record<RateLimitTier, RateLimiter>;

  constructor(
    opts: { host: string; port: number; rateLimitTight?: number; rateLimitStandard?: number },
    private readonly jwt: JwtConfig,
    private readonly matchsvc: MatchsvcClient,
    private readonly meta: MetaClient,
    private readonly socialsvc?: SocialsvcClient,
  ) {
    // maxPayload: `ws` defaults to 100MB per frame with no cap otherwise. Control-plane messages (room/duel/
    // judge JSON, matching internalHttp.ts's own 1MB request-body cap) are tiny — this just bounds the
    // memory/CPU an authenticated connection can force by sending an oversized frame.
    this.wss = new WebSocketServer({ host: opts.host, port: opts.port, path: '/gw', maxPayload: 1 << 20 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url, req.headers.host));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(this.heartbeat));
    this.tightLimit = opts.rateLimitTight ?? DEFAULT_RATE_LIMIT_TIGHT;
    this.standardLimit = opts.rateLimitStandard ?? DEFAULT_RATE_LIMIT_STANDARD;
    this.rateLimiters = {
      tight: createRateLimiter(null, 'gw-tight', this.tightLimit, RATE_LIMIT_WINDOW_MS),
      standard: createRateLimiter(null, 'gw-standard', this.standardLimit, RATE_LIMIT_WINDOW_MS),
    };
  }

  /** matchsvc → player: looks up the socket by accountId and pushes a message. Drops silently if the player is offline. */
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
      ...(msg.kind === 'match_bot' ? { seed: msg.seed, opponentName: msg.opponentName } : {}),
      ...(msg.kind === 'room_error' ? { code: msg.code, message: msg.message } : {}),
    });
    try {
      conn.ws.send(encodeServer(toServerMsg(msg)));
    } catch (e) {
      log.warn('push send failed', { accountId, err: (e as Error).message });
    }
  };

  /**
   * Redis pub/sub fan-out (SOC9 / §8.4): worldsvc publishes a single message with a recipient list to Redis;
   * each gateway instance delivers it only to recipients that are online on this node (offline or on a different node → skipped).
   * This way worldsvc emits a single message for a sect of ≤900 members, and the fan-out cost
   * falls on each gateway's local socket writes.
   */
  readonly routeBroadcast = (recipients: string[], msg: PushMsg, roomId?: string): void => {
    for (const accountId of recipients) {
      const conn = this.conns.get(accountId);
      // roomId (when the publisher included it — matchsvc does) keeps the cross-process log
      // correlation that the HTTP /gw/push path always had (observability/README).
      if (conn && conn.ws.readyState === conn.ws.OPEN) this.push(accountId, msg, roomId);
    }
  };

  /** Wired by index.ts once Redis connects — lets onConnection() notify sibling instances of a same-account takeover. */
  setKickPublisher(fn: (accountId: string, originInstanceId: string) => void): void {
    this.kickPublisher = fn;
  }

  /** Wired by index.ts once Redis connects — lets presenceOf() see accounts connected to a sibling instance.
   *  Also upgrades the rate limiters from the in-process fallback to the Redis-backed implementation (using
   *  the subscriber's dedicated rateLimitClient connection), so the per-accountId limits are precise across
   *  gateway instances instead of each instance keeping its own independent count. */
  setPresenceStore(store: GatewaySubscriber): void {
    this.presenceStore = store;
    this.rateLimiters = {
      tight: createRateLimiter(store.rateLimitClient, 'gw-tight', this.tightLimit, RATE_LIMIT_WINDOW_MS),
      standard: createRateLimiter(store.rateLimitClient, 'gw-standard', this.standardLimit, RATE_LIMIT_WINDOW_MS),
    };
  }

  /**
   * Cross-instance account takeover (2026-07-18, §8.4): received via Redis from another gateway
   * instance's onConnection(). Skip our own echo (we already evicted synchronously, in-process,
   * before publishing) — otherwise we'd kill the very connection we just accepted. Otherwise, if
   * this instance happens to be holding a now-stale connection for the account, evict it exactly
   * like the local same-instance path (4409 'replaced'); the ws 'close' handler does the rest
   * (conns cleanup, matchsvc.disconnected, presence broadcast).
   */
  readonly routeKick = (accountId: string, originInstanceId: string): void => {
    if (originInstanceId === this.instanceId) return;
    const conn = this.conns.get(accountId);
    if (!conn) return;
    log.info('evicting stale connection (cross-instance takeover)', { accountId });
    try {
      conn.ws.close(4409, 'replaced');
    } catch {
      /* ignore */
    }
  };

  /** Real-time stats aggregation (admin GET /internal/stats, OPS_DESIGN §4.1/§8): current number of online connections. */
  readonly stats = (): { online: number } => ({ online: this.conns.size });

  /**
   * Batch online-status query (used by meta to mark the online flag on friend lists). accountId → whether
   * there is an active connection — on THIS instance, or (2026-07-27) on a sibling instance via Redis, for
   * any id not found locally. Checks local `conns` first so a single-instance deployment (today's reality)
   * never touches Redis for this at all, and an id found locally never needs the (slower, best-effort) cross-
   * instance round trip.
   */
  readonly presenceOf = async (accountIds: string[]): Promise<Record<string, boolean>> => {
    const out: Record<string, boolean> = {};
    const unresolved: string[] = [];
    for (const id of accountIds) {
      const conn = this.conns.get(id);
      if (conn && conn.ws.readyState === conn.ws.OPEN) out[id] = true;
      else unresolved.push(id);
    }
    if (unresolved.length === 0) return out;
    const online = this.presenceStore ? await this.presenceStore.onlineAccountIds(unresolved) : new Set<string>();
    for (const id of unresolved) out[id] = online.has(id);
    return out;
  };

  /** Friend relationship changed (notified by meta) → clear cache; re-fetched on next broadcast/query. */
  readonly invalidateFriends = (accountId: string): void => {
    this.friendsCache.delete(accountId);
  };

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
  }

  // ───────────────────────── Friend online-status broadcast (SOC9) ─────────────────────────

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
   * Online/offline broadcast: pushes my friend_presence to friends who are currently online;
   * on connect, also sends me a snapshot of currently online friends.
   * P3: if socialsvc is configured, delegates fan-out to socialsvc (friend data is authoritative in nw_social).
   * Fallback: when socialsvc is not configured, broadcasts directly using meta.getFriends (friend data in metaserver).
   */
  private async broadcastPresence(accountId: string, online: boolean): Promise<void> {
    if (this.socialsvc?.available) {
      // P3 path: gateway only fires the event; socialsvc looks up friend edges in nw_social and handles fan-out
      if (online) {
        await this.socialsvc.notifyOnline(accountId);
      } else {
        await this.socialsvc.notifyOffline(accountId);
      }
      return;
    }
    // Fallback path: socialsvc not configured; gateway broadcasts directly using meta's friend list
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
      // On connect, reflect back: send that online friend's presence to me who just came online (on disconnect I'm already gone, no need to reflect).
      if (online) {
        const fPid = await this.publicIdOf(fid);
        if (fPid) this.push(accountId, { kind: 'friend_presence', publicId: fPid, online: true });
      }
    }
  }

  // ───────────────────────── Connection ─────────────────────────

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

    // Replace the existing connection for the same account (duplicate login / stale connection).
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
    // Tell sibling gateway instances too (2026-07-18): the account→socket map above is per-process,
    // so a stale connection on a DIFFERENT instance wouldn't be caught by the `prev` check. No-op
    // (kickPublisher unset) in single-instance/no-Redis deployments — this instance's own eviction above already sufficed.
    this.kickPublisher?.(accountId, this.instanceId);
    this.matchsvc.connected(accountId);
    // Friend online-status broadcast (SOC9): notify online friends that I came online + push me a snapshot of online friends.
    void this.broadcastPresence(accountId, true);
    void this.presenceStore?.markOnline(accountId);

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
        // Notify online friends that I went offline (no self-push; conn is already removed). Clear this
        // account's friendsCache/publicIdCache entries only AFTER that finishes (it needs them to know
        // who to notify) — without this, both caches (fallback-path-only, when socialsvc is down) grow
        // for the life of the process, one entry per account ever seen, never evicted.
        void this.broadcastPresence(accountId, false).finally(() => {
          this.friendsCache.delete(accountId);
          this.publicIdCache.delete(accountId);
        });
        void this.presenceStore?.markOffline(accountId);
      }
      // If this account was acting as a judge, immediately cancel its in-flight requests (no need to wait for timeout).
      for (const [id, p] of this.pendingJudges) {
        if (p.accountId !== accountId) continue;
        clearTimeout(p.timer);
        this.pendingJudges.delete(id);
        p.resolve({ ok: false });
      }
    });
    ws.on('error', () => {
      /* close event fires shortly after */
    });
  }

  /** Rate-limit gate (see RATE_LIMIT_WINDOW_MS/TIGHT_CASES/STANDARD_CASES above), then dispatch. Split out
   *  from dispatch() so the hot, unlimited cases (ping/client_caps/judge_verdict) never pay for the async
   *  limiter round trip — only messages in a gated tier take the Promise-then detour. */
  private handle(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    const tier = this.tierOf(msg.case);
    if (!tier) {
      this.dispatch(accountId, msg);
      return;
    }
    void this.rateLimiters[tier].allow(accountId, Date.now()).then((allowed) => {
      if (allowed) {
        this.dispatch(accountId, msg);
        return;
      }
      log.warn('rate limited', { accountId, case: msg.case, tier });
      this.pushRateLimited(accountId, msg);
    });
  }

  private tierOf(kase: ReturnType<typeof decodeClient>['case']): RateLimitTier | null {
    if (TIGHT_CASES.has(kase)) return 'tight';
    if (STANDARD_CASES.has(kase)) return 'standard';
    return null;
  }

  /** Explicit client feedback on a rate-limited control message (never silently dropped, per
   *  SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4). duel_invite reuses the existing duel_cancelled channel
   *  (same one used for not_found/offline) since the client already listens on it for this action; every
   *  other gated case reuses room_error's generic {code,message} shape. */
  private pushRateLimited(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    if (msg.case === 'duel_invite') {
      this.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'rate_limited' });
      return;
    }
    this.push(accountId, {
      kind: 'room_error',
      code: 'RATE_LIMITED',
      message: `too many ${msg.case} requests, slow down`,
    });
  }

  private dispatch(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    // ping is too frequent for info logging; use debug only; all other control messages are logged at info (main integration path).
    if (msg.case !== 'ping') log.info(`recv ${msg.case}`, { accountId });
    switch (msg.case) {
      case 'room_create': {
        const submittedDeck = msg.deck ?? [];
        if (msg.mode === MatchMode.RANKED) {
          log.info('-> ranked enqueue', { accountId });
          void this.enqueueRanked(accountId, submittedDeck);
        } else {
          log.info('-> matchsvc roomCreate', { accountId });
          void this.createRoomValidated(accountId, submittedDeck);
        }
        break;
      }
      case 'room_join': {
        const code = msg.code;
        log.info('-> matchsvc roomJoin', { accountId, code });
        void this.joinRoomValidated(accountId, code, msg.deck ?? []);
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
      case 'duel_invite':
        log.info('-> matchsvc duelInvite', { accountId, toPublicId: msg.toPublicId });
        void this.handleDuelInvite(accountId, msg.toPublicId, msg.deck ?? []);
        break;
      case 'duel_respond':
        log.info('-> matchsvc duelRespond', { accountId, inviteId: msg.inviteId, accept: msg.accept });
        void this.handleDuelRespond(accountId, msg.inviteId, msg.accept, msg.deck ?? []);
        break;
      case 'client_caps': {
        const conn = this.conns.get(accountId);
        if (conn) conn.canJudge = msg.canJudge;
        break;
      }
      case 'judge_verdict': {
        const pending = this.pendingJudges.get(msg.requestId);
        // Only accept the verdict from the designated judge (prevents another player from forging a verdict).
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

  // ───────────────────────── Peer judge (Phase C) ─────────────────────────

  /**
   * Called by meta (via /gw/judge): picks an eligible idle online player to headlessly re-compute the match and report the final-state hash.
   * No eligible candidate / timeout / re-computation failed → {ok:false}; meta voids the result (no penalty).
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
            cardInstancesJson: args.cardInstancesJson ?? '',
            equipmentInvJson: args.equipmentInvJson ?? '',
            topDeck: args.decks?.top ?? [],
            bottomDeck: args.decks?.bottom ?? [],
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pendingJudges.delete(requestId);
        resolve({ ok: false });
      }
    });
  }

  /**
   * Picks one online player who has canJudge set and is not in the exclude list (single-judge model).
   * Uniformly random among candidates (comm-audit-internal-2026-07-28 P0-10): the old "first match
   * in conns iteration order" both over-drafted long-lived connections and let a colluder park an
   * early connection to reliably occupy the judge seat for an accomplice's disputes.
   */
  private pickJudge(exclude: string[]): GwConn | null {
    const candidates: GwConn[] = [];
    for (const conn of this.conns.values()) {
      if (!conn.canJudge) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (exclude.includes(conn.accountId)) continue;
      candidates.push(conn);
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  /** Ranked enqueue: fetches ELO from meta first (keeping matchsvc DB-free), validates deck, then enqueues. */
  private async enqueueRanked(accountId: string, submittedDeck: string[]): Promise<void> {
    if (!this.meta.available) {
      log.warn('ranked rejected: meta unavailable (no ELO source)', { accountId });
      this.push(accountId, {
        kind: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked requires server storage',
      });
      return;
    }
    const identity = await this.meta.getMatchIdentity(accountId);
    // The player may have disconnected during the await → only enqueue if still online.
    if (!this.conns.has(accountId)) {
      log.warn('ranked enqueue aborted: account dropped during ELO fetch', { accountId });
      return;
    }
    const elo = identity.elo;
    const deck = this.resolvedDeck(accountId, submittedDeck, elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    log.info('-> matchsvc enqueue', { accountId, elo, deckSize: deck.length });
    const ok = await this.matchsvc.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, '', deck, equippedSkins);
    // Retries are already exhausted inside matchsvc.enqueue (see matchsvcClient's postInternal
    // retries=2) — a false here means the command never landed at all, so the client's
    // "searching" UI would otherwise wait forever with no signal (P0-7, comm-audit finding B8).
    if (!ok && this.conns.has(accountId)) {
      log.warn('ranked enqueue failed after retries: notifying client', { accountId });
      this.push(accountId, { kind: 'room_error', code: 'RANKED_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /**
   * Friendly (custom) room create: validate the submitted deck against the player's *current* elo,
   * exactly like ranked — friendly rooms are NOT a sandbox (PVP_LOADOUT §6.3, universal server-side
   * gating). Without this, an empty/unvalidated deck lets the engine fall back to the full card pool.
   */
  private async createRoomValidated(accountId: string, submittedDeck: string[]): Promise<void> {
    const identity = await this.meta.getMatchIdentity(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    const ok = await this.matchsvc.roomCreate(accountId, name, publicId, equippedTitle, avatarId, deck, equippedSkins);
    // No retry inside roomCreate (not idempotent) — a single failed attempt still deserves an
    // explicit error instead of leaving the "connecting" UI stuck with no signal (P0-7).
    if (!ok && this.conns.has(accountId)) {
      log.warn('room create failed: notifying client', { accountId });
      this.push(accountId, { kind: 'room_error', code: 'MATCHMAKING_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /** Friendly room join: same current-elo deck gating as create (PVP_LOADOUT §6.3). */
  private async joinRoomValidated(accountId: string, code: string, submittedDeck: string[]): Promise<void> {
    const identity = await this.meta.getMatchIdentity(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    const ok = await this.matchsvc.roomJoin(accountId, name, publicId, code, equippedTitle, avatarId, deck, equippedSkins);
    if (!ok && this.conns.has(accountId)) {
      log.warn('room join failed: notifying client', { accountId });
      this.push(accountId, { kind: 'room_error', code: 'MATCHMAKING_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /**
   * Friend challenge ("切磋", ADR friends-duel-confirm) invite: the client only knows the friend's
   * publicId, so this resolves it to an accountId (meta) before ever touching matchsvc — matchsvc
   * itself only ever deals in accountIds (like every other command here). Same current-elo deck
   * gating as room create/join/ranked (PVP_LOADOUT §6.3). Offline/unknown target short-circuits
   * with an immediate duel_cancelled back to the inviter instead of creating a pending invite that
   * could never be answered.
   */
  private async handleDuelInvite(accountId: string, toPublicId: string, submittedDeck: string[]): Promise<void> {
    const resolved = await this.meta.resolveByPublicId(toPublicId);
    if (!this.conns.has(accountId)) return;
    if (!resolved || resolved.accountId === accountId) {
      this.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'not_found' });
      return;
    }
    if (!this.conns.has(resolved.accountId)) {
      this.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'offline' });
      return;
    }
    const identity = await this.meta.getMatchIdentity(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    this.matchsvc.duelInvite(accountId, name, publicId, equippedTitle, avatarId, resolved.accountId, deck, equippedSkins);
  }

  /** Accept/decline a friend-challenge invite. Only accept needs the responder's own profile + deck
   *  (elo-gated same as create/join) — decline is a plain pass-through, no lookups needed. */
  private async handleDuelRespond(accountId: string, inviteId: string, accept: boolean, submittedDeck: string[]): Promise<void> {
    if (!accept) {
      this.matchsvc.duelRespond(accountId, inviteId, false);
      return;
    }
    const identity = await this.meta.getMatchIdentity(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    this.matchsvc.duelRespond(accountId, inviteId, true, name, publicId, equippedTitle, avatarId, deck, equippedSkins);
  }

  /**
   * Validate the submitted deck against the player's *current*-elo unlocked card set; fall back to
   * defaultPvpDeck on rejection. A dropped-elo player must not keep high-tier units in a low matchup.
   * Server-side guard: client-side validation is UX, this is the authority (PVP_LOADOUT §6.3).
   */
  private resolvedDeck(accountId: string, submitted: string[], elo: number): string[] {
    if (submitted.length === 0) return defaultPvpDeck();
    const result = validatePvpDeck(submitted, elo);
    if (!result.valid) {
      log.warn('invalid pvp deck submitted, falling back to default', { accountId, error: result.error });
      return defaultPvpDeck();
    }
    return submitted;
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
      // Keep this account's cross-instance presence key from expiring (redis.ts PRESENCE_TTL_MS is sized
      // to survive exactly one of these HEARTBEAT_MS gaps, so a crashed instance's accounts self-heal).
      void this.presenceStore?.refreshOnline(conn.accountId);
    }
  }
}

// matchsvc PushMsg (proto-agnostic) → control-plane ServerMsg.
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
    case 'match_bot':
      return {
        case: 'match_bot',
        seed: msg.seed,
        opponentName: msg.opponentName,
        elo: msg.elo,
        difficulty: msg.difficulty,
      };
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
        ownerPublicId: msg.ownerPublicId,
        ownerName: msg.ownerName,
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
        marchId: msg.marchId,
        tile: msg.tile,
        outcome: msg.outcome,
        lootSummary: msg.lootSummary,
        replayRef: msg.replayRef,
        attackerId: msg.attackerId,
        marchKind: msg.marchKind,
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
    case 'nation_msg':
      return {
        case: 'nation_msg',
        worldId: msg.worldId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'duel_invited':
      return { case: 'duel_invited', inviteId: msg.inviteId, fromPublicId: msg.fromPublicId, fromName: msg.fromName };
    case 'duel_cancelled':
      return { case: 'duel_cancelled', inviteId: msg.inviteId, reason: msg.reason };
    case 'queue_state':
      return { case: 'queue_state' };
    case 'prematch_lost':
      return { case: 'pre_match_lost', context: msg.context };
  }
}
