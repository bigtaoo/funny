// Matchsvc.ts split (2026-08-10, ≤500-line convention, composition base layer): the shared "launch a
// match" logic that rooms.ts (both-ready auto-start / host start), queue.ts (ranked pair found), and
// duel.ts (invite accepted) all call into — picks a game server, signs both sides' tickets, best-effort
// caches the resume-prompt active-match record, and pushes match_found. Has zero dependency on any of
// those three siblings (the "shared lower-level class both [siblings] depend on" resolution — see
// RoomLookupPort's doc comment in types.ts for the analogous reasoning on the rooms/queue pair): all three
// depend downward on this one, never on each other, so composing them stays acyclic.
import { randomUUID, randomInt } from 'crypto';
import { signTicket, createLogger, defaultPvpDeck, setActiveMatch, type RedisLike, type TicketClaims } from '@nw/shared';
import type { GameRegistry } from '../GameRegistry';
import type { MatchStarterPort, Push, PushMsg, StartMatchPlayer } from './types';

const log = createLogger('matchsvc');

export interface MatchStarterDeps {
  push: Push;
  games: GameRegistry;
  internalKey: string;
  ticketTtlSec: number;
  /** Active-match Redis client (login-reconnect-prompt), or null when unconfigured — resume prompt is
   *  then unavailable but starting the match itself is unaffected. */
  redis: RedisLike | null;
}

export class MatchStarter implements MatchStarterPort {
  constructor(private readonly deps: MatchStarterDeps) {}

  start(mode: 'friendly' | 'ranked', a: StartMatchPlayer, b: StartMatchPlayer): void {
    const gameUrl = this.deps.games.pick();
    if (!gameUrl) {
      log.error('startMatch aborted: no game server available (none registered + no fallback)', {
        a: a.accountId,
        b: b.accountId,
        mode,
      });
      const msg: PushMsg = { kind: 'room_error', code: 'GAME_UNAVAILABLE', message: 'no game server available' };
      this.deps.push(a.accountId, msg);
      this.deps.push(b.accountId, msg);
      return;
    }
    const roomId = randomUUID();
    const seed = randomInt(1, 2 ** 48); // < 2^48, within safe integer range
    // a = side 0 (top), b = side 1 (bottom) — both tickets carry both decks for deterministic engine construction.
    // Every matchsvc match is PvP, which must never draw from the full card pool. An empty deck (missing
    // or unvalidated upstream) is resolved to defaultPvpDeck here so the engine always gets a gated deck —
    // the engine's undefined-decks fallback is the full CARD_DEFINITIONS pool, which would leak locked units.
    const decks = {
      top: a.deck.length > 0 ? a.deck : defaultPvpDeck(),
      bottom: b.deck.length > 0 ? b.deck : defaultPvpDeck(),
    };
    log.info('match starting', { mode, roomId, gameUrl, a: a.accountId, b: b.accountId, seed, topDeck: decks.top.length, bottomDeck: decks.bottom.length });

    const sign = (
      self: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string; equippedSkins: string[] },
      opp: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string; equippedSkins: string[] },
      side: 0 | 1,
    ): string => {
      const claims: TicketClaims = {
        roomId,
        seed,
        side,
        mode,
        opponent: opp.name,
        opponentPublicId: opp.publicId,
        opponentTitle: opp.equippedTitle || undefined,
        opponentAvatarId: opp.avatarId || undefined,
        opponentSkins: opp.equippedSkins.length ? opp.equippedSkins : undefined,
        gameUrl,
        accountId: self.accountId,
        decks,
      };
      return signTicket(claims, { key: this.deps.internalKey, ttlSec: this.deps.ticketTtlSec });
    };

    const ticketA = sign(a, b, 0);
    const ticketB = sign(b, a, 1);

    // Cache both tickets under accountId so a later re-login can offer "resume this match?" and
    // reconnect straight into the room — gameserver's initial handshake ignores ticket exp (M16),
    // so these remain usable for the whole match, not just the 30s matchmaking handshake window.
    // Best-effort: matchmaking must not fail if Redis is unavailable.
    void setActiveMatch(this.deps.redis, a.accountId, { roomId, gameUrl, ticket: ticketA, mode }).catch((e) =>
      log.warn('setActiveMatch failed', { accountId: a.accountId, roomId, err: (e as Error).message }),
    );
    void setActiveMatch(this.deps.redis, b.accountId, { roomId, gameUrl, ticket: ticketB, mode }).catch((e) =>
      log.warn('setActiveMatch failed', { accountId: b.accountId, roomId, err: (e as Error).message }),
    );

    this.deps.push(a.accountId, { kind: 'match_found', gameUrl, ticket: ticketA }, roomId);
    this.deps.push(b.accountId, { kind: 'match_found', gameUrl, ticket: ticketB }, roomId);
  }
}
