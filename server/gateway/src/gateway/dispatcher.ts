// gateway/Gateway.ts split (2026-08-10, ≤500-line convention, composition layer #5 — the top of the stack):
// per-connection rate limiting + the control-message switch. Depends on the narrow `ConnLookup`/`Push`
// surface from connRegistry, matchsvc for the three synchronous pass-throughs, and the `MatchCommandsPort`/
// `PeerJudgePort` interfaces (only the methods actually called here) so it never needs matchCommands'/
// peerJudge's full public surface.
import { createRateLimiter, createLogger, type RateLimiter, type RedisLike } from '@nw/shared';
import { decodeClient, encodeServer, MatchMode } from '../proto';
import type { MatchsvcClient } from '../matchsvcClient';
import {
  DEFAULT_RATE_LIMIT_STANDARD,
  DEFAULT_RATE_LIMIT_TIGHT,
  RATE_LIMIT_WINDOW_MS,
  STANDARD_CASES,
  TIGHT_CASES,
  type ConnLookup,
  type Push,
  type RateLimitTier,
} from './types';

const log = createLogger('gateway');

/** Narrow view of matchCommands — only the async handlers dispatch() forwards control messages to. */
export interface MatchCommandsPort {
  enqueueRanked(accountId: string, submittedDeck: string[]): Promise<void>;
  createRoomValidated(accountId: string, submittedDeck: string[]): Promise<void>;
  joinRoomValidated(accountId: string, code: string, submittedDeck: string[]): Promise<void>;
  handleDuelInvite(accountId: string, toPublicId: string, submittedDeck: string[]): Promise<void>;
  handleDuelRespond(accountId: string, inviteId: string, accept: boolean, submittedDeck: string[]): Promise<void>;
}

/** Narrow view of peerJudge — only the verdict-resolution entry point dispatch()'s judge_verdict case needs. */
export interface PeerJudgePort {
  resolveVerdict(
    accountId: string,
    msg: { requestId: string; ok: boolean; stateHash?: string; winnerSide?: number; stars?: number; statsJson?: string },
  ): void;
}

export interface DispatcherDeps {
  conns: ConnLookup;
  push: Push;
  matchsvc: Pick<MatchsvcClient, 'roomReady' | 'roomStart' | 'roomLeave'>;
  matchCommands: MatchCommandsPort;
  peerJudge: PeerJudgePort;
}

export class Dispatcher {
  private readonly tightLimit: number;
  private readonly standardLimit: number;
  /** In-process fallback until (if ever) upgradeRateLimiters wires a Redis client — same "start local, upgrade
   *  to precise-across-instances once Redis is up" shape as metaserver's createRateLimiter call sites. */
  private rateLimiters: Record<RateLimitTier, RateLimiter>;

  constructor(
    opts: { rateLimitTight?: number; rateLimitStandard?: number },
    private readonly deps: DispatcherDeps,
  ) {
    this.tightLimit = opts.rateLimitTight ?? DEFAULT_RATE_LIMIT_TIGHT;
    this.standardLimit = opts.rateLimitStandard ?? DEFAULT_RATE_LIMIT_STANDARD;
    this.rateLimiters = {
      tight: createRateLimiter(null, 'gw-tight', this.tightLimit, RATE_LIMIT_WINDOW_MS),
      standard: createRateLimiter(null, 'gw-standard', this.standardLimit, RATE_LIMIT_WINDOW_MS),
    };
  }

  /** Rebuilds both limiters against a Redis client once one connects (Gateway.ts's setPresenceStore),
   *  so the per-accountId limits are precise across gateway instances instead of each instance keeping
   *  its own independent count. */
  upgradeRateLimiters(rateLimitClient: RedisLike): void {
    this.rateLimiters = {
      tight: createRateLimiter(rateLimitClient, 'gw-tight', this.tightLimit, RATE_LIMIT_WINDOW_MS),
      standard: createRateLimiter(rateLimitClient, 'gw-standard', this.standardLimit, RATE_LIMIT_WINDOW_MS),
    };
  }

  /** Rate-limit gate (see RATE_LIMIT_WINDOW_MS/TIGHT_CASES/STANDARD_CASES in types.ts), then dispatch. Split
   *  out from dispatch() so the hot, unlimited cases (ping/client_caps/judge_verdict) never pay for the
   *  async limiter round trip — only messages in a gated tier take the Promise-then detour. */
  handle(accountId: string, msg: ReturnType<typeof decodeClient>): void {
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
   *  SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4): duel_invite reuses the existing duel_cancelled channel
   *  (same one used for not_found/offline) since the client already listens on it for this action; every
   *  other gated case reuses room_error's generic {code,message} shape. */
  private pushRateLimited(accountId: string, msg: ReturnType<typeof decodeClient>): void {
    if (msg.case === 'duel_invite') {
      this.deps.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'rate_limited' });
      return;
    }
    this.deps.push(accountId, {
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
          void this.deps.matchCommands.enqueueRanked(accountId, submittedDeck);
        } else {
          log.info('-> matchsvc roomCreate', { accountId });
          void this.deps.matchCommands.createRoomValidated(accountId, submittedDeck);
        }
        break;
      }
      case 'room_join': {
        const code = msg.code;
        log.info('-> matchsvc roomJoin', { accountId, code });
        void this.deps.matchCommands.joinRoomValidated(accountId, code, msg.deck ?? []);
        break;
      }
      case 'room_ready':
        this.deps.matchsvc.roomReady(accountId, msg.ready);
        break;
      case 'room_start':
        this.deps.matchsvc.roomStart(accountId);
        break;
      case 'room_leave':
        this.deps.matchsvc.roomLeave(accountId);
        break;
      case 'duel_invite':
        log.info('-> matchsvc duelInvite', { accountId, toPublicId: msg.toPublicId });
        void this.deps.matchCommands.handleDuelInvite(accountId, msg.toPublicId, msg.deck ?? []);
        break;
      case 'duel_respond':
        log.info('-> matchsvc duelRespond', { accountId, inviteId: msg.inviteId, accept: msg.accept });
        void this.deps.matchCommands.handleDuelRespond(accountId, msg.inviteId, msg.accept, msg.deck ?? []);
        break;
      case 'client_caps': {
        const conn = this.deps.conns.get(accountId);
        if (conn) conn.canJudge = msg.canJudge;
        break;
      }
      case 'judge_verdict':
        this.deps.peerJudge.resolveVerdict(accountId, msg);
        break;
      case 'ping':
        this.sendPong(accountId);
        break;
      case 'unknown':
        break;
    }
  }

  private sendPong(accountId: string): void {
    const conn = this.deps.conns.get(accountId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(encodeServer({ case: 'pong' }));
    } catch {
      /* ignore */
    }
  }
}
