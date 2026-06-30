// Match ticket (M18, S1-M): signed by matchsvc, verified by gameserver.
//
// After matchmaking or the room host starting a game, matchsvc issues one ticket per player
// (HMAC-JWT, key = NW_INTERNAL_KEY), delivered to the client via gateway (match_found).
// The client uses the ticket to connect to the game data-plane WS (?ticket=<jwt>);
// gameserver only verifies the signature and cross-checks that both tickets share the same room_id/seed
// before starting the game — it never queries any database (M16).
//
// Design reference: SERVER_API.md §8.2, MATCHSVC_DESIGN.md §2.4.
import jwt from 'jsonwebtoken';

export interface TicketClaims {
  /** Match ID (both tickets share the same ID; game cross-checks for consistency before starting). */
  roomId: string;
  /** Deterministic engine seed (both tickets share the same seed). */
  seed: number;
  /** This player's side (→ match_start.local_side). */
  side: 0 | 1;
  mode: 'friendly' | 'ranked';
  /** Opponent display name (for UI). */
  opponent: string;
  /** Opponent 9-digit public ID (UI display only; defaults to empty string). */
  opponentPublicId: string;
  /** Opponent's currently equipped title ID (UI display only; defaults to empty string). */
  opponentTitle?: string;
  /** Public WebSocket address of the assigned gameserver (written into match_found.game_url). */
  gameUrl: string;
  /**
   * This player's accountId. At match end, gameserver reports to meta to settle ELO,
   * which requires mapping side → accountId when writing saves.pvp.
   * Irrelevant to server game logic (M16); accountId is passed through only as a reporting identifier — no database read occurs.
   */
  accountId: string;
  /**
   * Both players' decks (PVP_LOADOUT §6.2). Each client receives both so it can construct the
   * GameEngine with matching UniformCardDrawPolicy for top + bottom player.
   * Absent for pre-P3 clients or when no deck was submitted (gameserver/client fall back to defaultPvpDeck).
   */
  decks?: { top: string[]; bottom: string[] };
}

interface TicketPayload extends TicketClaims {
  /** Expiry timestamp in seconds (standard JWT exp). */
  exp: number;
}

export interface TicketConfig {
  /** Shared internal secret key (ServerEnv.internalKey). */
  key: string;
  /** Validity duration in seconds (tolerance window from match_found to gameserver connection). Default: 30s. */
  ttlSec?: number;
}

/** Sign a ticket (HMAC-SHA256 JWT). */
export function signTicket(claims: TicketClaims, cfg: TicketConfig): string {
  const ttl = cfg.ttlSec ?? 30;
  return jwt.sign(claims, cfg.key, { expiresIn: ttl });
}

/**
 * Verify the ticket signature and extract its claims. When `ignoreExpiration` is true,
 * only the signature is checked and exp is ignored —
 * on reconnect (conn_resume) the same ticket is reused; the match is already live, so exp
 * only constrains the initial handshake. Reconnect handshakes therefore accept expired-but-still-validly-signed
 * tickets (the initial connection has RoomManager check exp itself).
 * Throws on failure (caller should close the connection).
 */
export function verifyTicket(
  token: string,
  cfg: TicketConfig,
  opts: { ignoreExpiration?: boolean } = {},
): TicketPayload {
  const decoded = jwt.verify(token, cfg.key, {
    ignoreExpiration: opts.ignoreExpiration ?? false,
  });
  if (
    typeof decoded === 'string' ||
    typeof decoded.roomId !== 'string' ||
    typeof decoded.seed !== 'number' ||
    (decoded.side !== 0 && decoded.side !== 1)
  ) {
    throw new Error('invalid ticket payload');
  }
  return decoded as TicketPayload;
}
