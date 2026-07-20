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
import { verifyToken, createLogger, validatePvpDeck, defaultPvpDeck, type JwtConfig } from '@nw/shared';

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

const HEARTBEAT_MS = 30_000;
/** Maximum wait time for judge re-computation + report (includes network round-trip + client running the full match). */
const JUDGE_TIMEOUT_MS = 20_000;

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
  /** @deprecated S3-2 blueprint snapshot; replaced by unitLevels from S12 onwards (retained for backward compatibility). */
  pveUpgrades?: Record<string, number>;
  /** S12 unit progression level snapshot (unitId→1..9), ensures deterministic PvE/siege re-computation. Takes precedence over pveUpgrades. */
  unitLevels?: Record<string, number>;
  /** SLG siege defense config JSON string (S8-3b): if non-empty, the judge re-runs in siege mode. */
  defenseJson?: string;
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
  /** In-flight judge requests (requestId → pending). Cleared when a verdict arrives or on timeout. */
  private readonly pendingJudges = new Map<string, PendingJudge>();
  private judgeSeq = 0;
  /** Friends-list cache (accountId → friend accountId[]); invalidated by friend changes via /gw/social/invalidate. */
  private readonly friendsCache = new Map<string, string[]>();
  /** publicId cache (accountId → publicId); reused for presence broadcasts to avoid querying meta on every event. */
  private readonly publicIdCache = new Map<string, string>();

  constructor(
    opts: { host: string; port: number },
    private readonly jwt: JwtConfig,
    private readonly matchsvc: MatchsvcClient,
    private readonly meta: MetaClient,
    private readonly socialsvc?: SocialsvcClient,
  ) {
    this.wss = new WebSocketServer({ host: opts.host, port: opts.port, path: '/gw' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url, req.headers.host));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(this.heartbeat));
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
  readonly routeBroadcast = (recipients: string[], msg: PushMsg): void => {
    for (const accountId of recipients) {
      const conn = this.conns.get(accountId);
      if (conn && conn.ws.readyState === conn.ws.OPEN) this.push(accountId, msg);
    }
  };

  /** Wired by index.ts once Redis connects — lets onConnection() notify sibling instances of a same-account takeover. */
  setKickPublisher(fn: (accountId: string, originInstanceId: string) => void): void {
    this.kickPublisher = fn;
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

  /** Batch online-status query (used by meta to mark the online flag on friend lists). accountId → whether there is an active connection. */
  readonly presenceOf = (accountIds: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of accountIds) {
      const conn = this.conns.get(id);
      out[id] = !!conn && conn.ws.readyState === conn.ws.OPEN;
    }
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
        // Notify online friends that I went offline (no self-push; conn is already removed).
        void this.broadcastPresence(accountId, false);
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

  private handle(accountId: string, msg: ReturnType<typeof decodeClient>): void {
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
            pveUpgrades: args.pveUpgrades ?? {},
            unitLevels: args.unitLevels ?? {},
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

  /** Picks one online player who has canJudge set and is not in the exclude list (any one will do; single-judge model). */
  private pickJudge(exclude: string[]): GwConn | null {
    for (const conn of this.conns.values()) {
      if (!conn.canJudge) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (exclude.includes(conn.accountId)) continue;
      return conn;
    }
    return null;
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
    const { elo } = await this.meta.getElo(accountId);
    // The player may have disconnected during the await → only enqueue if still online.
    if (!this.conns.has(accountId)) {
      log.warn('ranked enqueue aborted: account dropped during ELO fetch', { accountId });
      return;
    }
    const deck = this.resolvedDeck(accountId, submittedDeck, elo);
    const { name, publicId, equippedTitle, avatarId } = await this.resolveProfile(accountId);
    if (!this.conns.has(accountId)) return;
    log.info('-> matchsvc enqueue', { accountId, elo, deckSize: deck.length });
    this.matchsvc.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, '', deck);
  }

  /**
   * Friendly (custom) room create: validate the submitted deck against the player's *current* elo,
   * exactly like ranked — friendly rooms are NOT a sandbox (PVP_LOADOUT §6.3, universal server-side
   * gating). Without this, an empty/unvalidated deck lets the engine fall back to the full card pool.
   */
  private async createRoomValidated(accountId: string, submittedDeck: string[]): Promise<void> {
    const { elo } = await this.meta.getElo(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, elo);
    const { name, publicId, equippedTitle, avatarId } = await this.resolveProfile(accountId);
    if (!this.conns.has(accountId)) return;
    this.matchsvc.roomCreate(accountId, name, publicId, equippedTitle, avatarId, deck);
  }

  /** Friendly room join: same current-elo deck gating as create (PVP_LOADOUT §6.3). */
  private async joinRoomValidated(accountId: string, code: string, submittedDeck: string[]): Promise<void> {
    const { elo } = await this.meta.getElo(accountId);
    if (!this.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, elo);
    const { name, publicId, equippedTitle, avatarId } = await this.resolveProfile(accountId);
    if (!this.conns.has(accountId)) return;
    this.matchsvc.roomJoin(accountId, name, publicId, code, equippedTitle, avatarId, deck);
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

  /**
   * Player display profile: fetches the real nickname and 9-digit numeric publicId from meta.
   * If meta is unavailable or no profile exists, falls back to the first 12 characters of accountId for the name
   * and an empty string for publicId (room creation still works, the name just won't be user-friendly).
   */
  private async resolveProfile(accountId: string): Promise<{ name: string; publicId: string; equippedTitle: string; avatarId: string }> {
    const p = await this.meta.getProfile(accountId);
    return { name: p.displayName || displayName(accountId), publicId: p.publicId ?? '', equippedTitle: p.equippedTitle ?? '', avatarId: p.avatarId ?? '' };
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
  }
}
