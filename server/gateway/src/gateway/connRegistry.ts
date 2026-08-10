// gateway/Gateway.ts split (2026-08-10, ≤500-line convention, composition layer #1 — the base every other
// layer reads through the narrow `ConnLookup`/`Push` surface, mirroring auctionService's base.ts role):
// owns the account→socket map, the WS handshake/heartbeat/close lifecycle, cross-instance kick, and presence
// queries. Talks to sibling layers ONLY through the three callbacks in ConnRegistryDeps — it never imports
// presenceBroadcaster/dispatcher/peerJudge directly, so the composition stays one-directional (assembled by
// the Gateway.ts shell, see its onOnline/onOffline/onMessage wiring).
import { randomUUID } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken, createLogger, type JwtConfig } from '@nw/shared';
import { decodeClient, encodeServer, type ServerMsg } from '../proto';
import type { PushMsg } from '../matchsvcClient';
import type { GatewaySubscriber } from '../redis';
import { HEARTBEAT_MS, toServerMsg, type GwConn, type Push } from './types';

const log = createLogger('gateway');

export interface ConnRegistryDeps {
  jwt: JwtConfig;
  matchsvc: { connected(accountId: string): void; disconnected(accountId: string): void };
  /** Friend online-status broadcast (SOC9) on connect — fire-and-forget, composed in Gateway.ts. */
  onOnline(accountId: string): void;
  /** Friend online-status broadcast on disconnect — fire-and-forget, composed in Gateway.ts. Only fires
   *  when the closing socket is still the one on record for accountId (guards against a stale/replaced
   *  connection's belated 'close' wrongly announcing the account offline after a new connection took over). */
  onOffline(accountId: string): void;
  /** Fires on EVERY socket close, unconditionally — unlike onOffline, not guarded by "is this still the
   *  live connection". Used for peer-judge cleanup (Gateway.ts wires this to peerJudge.cancelPendingFor):
   *  a pending judge assignment tied to this accountId must be cancelled even if the closing socket was
   *  a stale duplicate already superseded by a newer connection for the same account. */
  onSocketClosed(accountId: string): void;
  /** Decoded client control message → dispatcher. */
  onMessage(accountId: string, msg: ReturnType<typeof decodeClient>): void;
}

export class ConnRegistry {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, GwConn>(); // accountId → active connection
  private readonly heartbeat: NodeJS.Timeout;
  /** Stable per-process id (2026-07-18): tags this instance's own kick broadcasts so it can ignore
   *  its own echo instead of evicting the very connection it just accepted (see onConnection). */
  private readonly instanceId = randomUUID();
  /** Set once Redis connects (index.ts); null in single-instance/no-Redis deployments, where the
   *  local eviction in onConnection() already fully covers same-account takeover. */
  private kickPublisher: ((accountId: string, originInstanceId: string, connSeq: number) => void) | null = null;
  /** Tiebreak counter for nextConnSeq (guarantees strictly-increasing values for connections landing on
   *  THIS instance within the same millisecond; cross-instance ordering still relies on wall-clock). */
  private connSeqCounter = 0;
  /** Set once Redis connects (index.ts, same subscriber as kickPublisher above); null = presenceOf only
   *  ever sees this instance's own connections (correct for today's single-instance deployment). */
  private presenceStore: GatewaySubscriber | null = null;

  constructor(
    opts: { host: string; port: number },
    private readonly deps: ConnRegistryDeps,
  ) {
    // maxPayload: `ws` defaults to 100MB per frame with no cap otherwise. Control-plane messages (room/duel/
    // judge JSON, matching internalHttp.ts's own 1MB request-body cap) are tiny — this just bounds the
    // memory/CPU an authenticated connection can force by sending an oversized frame.
    this.wss = new WebSocketServer({ host: opts.host, port: opts.port, path: '/gw', maxPayload: 1 << 20 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url, req.headers.host));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.wss.on('close', () => clearInterval(this.heartbeat));
  }

  /** matchsvc → player: looks up the socket by accountId and pushes a message. Drops silently if the player is offline. */
  readonly push: Push = (accountId, msg, roomId) => {
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
      conn.ws.send(encodeServer(toServerMsg(msg) as ServerMsg));
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
  routeBroadcast(recipients: string[], msg: PushMsg, roomId?: string): void {
    for (const accountId of recipients) {
      const conn = this.conns.get(accountId);
      // roomId (when the publisher included it — matchsvc does) keeps the cross-process log
      // correlation that the HTTP /gw/push path always had (observability/README).
      if (conn && conn.ws.readyState === conn.ws.OPEN) this.push(accountId, msg, roomId);
    }
  }

  /** Wired by index.ts once Redis connects — lets onConnection() notify sibling instances of a same-account takeover. */
  setKickPublisher(fn: (accountId: string, originInstanceId: string, connSeq: number) => void): void {
    this.kickPublisher = fn;
  }

  /** Wired by index.ts once Redis connects — lets presenceOf() see accounts connected to a sibling instance. */
  setPresenceStore(store: GatewaySubscriber): void {
    this.presenceStore = store;
  }

  get(accountId: string): GwConn | undefined {
    return this.conns.get(accountId);
  }

  has(accountId: string): boolean {
    return this.conns.has(accountId);
  }

  values(): IterableIterator<GwConn> {
    return this.conns.values();
  }

  /** Real-time stats aggregation (admin GET /internal/stats, OPS_DESIGN §4.1/§8): current number of online connections. */
  stats(): { online: number } {
    return { online: this.conns.size };
  }

  /**
   * Batch online-status query (used by meta to mark the online flag on friend lists). accountId → whether
   * there is an active connection — on THIS instance, or (2026-07-27) on a sibling instance via Redis, for
   * any id not found locally. Checks local `conns` first so a single-instance deployment (today's reality)
   * never touches Redis for this at all, and an id found locally never needs the (slower, best-effort) cross-
   * instance round trip.
   */
  async presenceOf(accountIds: string[]): Promise<Record<string, boolean>> {
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
  }

  /** Monotonic per-connection sequence (2026-08-04 fix, cross-instance reconnect race): combines wall-clock
   *  time with an in-process tiebreak counter. Two connections for the same account landing on DIFFERENT
   *  instances near-simultaneously (e.g. a client-side reconnect racing itself across a load balancer) each
   *  used to publish an unconditional kick — so the instance holding the connection that actually won the
   *  race would still receive the LOSER's kick broadcast microseconds later and close its own, brand-new
   *  socket. routeKick now compares connSeq and only evicts when the incoming kick is strictly newer.
   */
  private nextConnSeq(): number {
    return Date.now() * 1000 + (this.connSeqCounter = (this.connSeqCounter + 1) % 1000);
  }

  /**
   * Cross-instance account takeover (2026-07-18, §8.4): received via Redis from another gateway
   * instance's onConnection(). Skip our own echo (we already evicted synchronously, in-process,
   * before publishing) — otherwise we'd kill the very connection we just accepted. Otherwise, if
   * this instance happens to be holding a now-stale connection for the account, evict it exactly
   * like the local same-instance path (4409 'replaced'); the ws 'close' handler does the rest
   * (conns cleanup, matchsvc.disconnected, presence broadcast).
   */
  readonly routeKick = (accountId: string, originInstanceId: string, remoteConnSeq: number): void => {
    if (originInstanceId === this.instanceId) return;
    const conn = this.conns.get(accountId);
    if (!conn) return;
    // If our local connection is actually NEWER than the one that triggered this kick, it already won a
    // simultaneous-reconnect race against the other instance — evicting it here would kill the winner
    // instead of the loser (see nextConnSeq's doc).
    if (conn.connSeq > remoteConnSeq) return;
    log.info('evicting stale connection (cross-instance takeover)', { accountId });
    try {
      conn.ws.close(4409, 'replaced');
    } catch {
      /* ignore */
    }
  };

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
  }

  private onConnection(ws: WebSocket, url: string | undefined, host: string | undefined): void {
    const u = new URL(url ?? '', `ws://${host ?? 'localhost'}`);
    const token = u.searchParams.get('token');
    let accountId: string;
    try {
      accountId = verifyToken(token ?? '', this.deps.jwt);
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
    const conn: GwConn = { accountId, ws, alive: true, canJudge: false, connSeq: this.nextConnSeq() };
    this.conns.set(accountId, conn);
    log.info('WS connected', { accountId, online: this.conns.size });
    // Tell sibling gateway instances too (2026-07-18): the account→socket map above is per-process,
    // so a stale connection on a DIFFERENT instance wouldn't be caught by the `prev` check. No-op
    // (kickPublisher unset) in single-instance/no-Redis deployments — this instance's own eviction above already sufficed.
    this.kickPublisher?.(accountId, this.instanceId, conn.connSeq);
    this.deps.matchsvc.connected(accountId);
    this.deps.onOnline(accountId);
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
      this.deps.onMessage(accountId, msg);
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', (code: number) => {
      if (this.conns.get(accountId) === conn) {
        this.conns.delete(accountId);
        log.info('WS closed', { accountId, code, online: this.conns.size });
        this.deps.matchsvc.disconnected(accountId);
        this.deps.onOffline(accountId);
        void this.presenceStore?.markOffline(accountId);
      }
      // Unconditional (see onSocketClosed's doc) — must run even for a stale duplicate's belated close.
      this.deps.onSocketClosed(accountId);
    });
    ws.on('error', () => {
      /* close event fires shortly after */
    });
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
