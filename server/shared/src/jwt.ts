// Stateless JWT (SERVER_API.md §1.1). accountId is extracted from the token; the request body does not carry it.
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  /** accountId */
  sub: string;
  /** Expiry, epoch **seconds** (jsonwebtoken's own unit). Always set by signToken (expiresIn has a default). */
  exp?: number;
  /** Issued-at, epoch seconds. Set by jsonwebtoken on every token it signs. */
  iat?: number;
}

export interface JwtConfig {
  secret: string;
  /** Expiry duration (zeit/ms string or seconds). Default: 30d. */
  expiresIn?: string | number;
}

/**
 * Sliding-renewal window (ACCOUNT_DESIGN.md §5): once a token has less than this left, the
 * metaserver's bearerAuth handler re-signs it and returns the fresh one in `x-nw-token`, so a
 * player who keeps playing never hits the 30d wall (2026-09-10 iPhone report: signToken is only
 * ever called from an explicit login/register/OAuth-bind, so the clock ran from the last time the
 * password was typed, regardless of how active the account was).
 *
 * 10 days against a 30d TTL: any player who opens the app at least once every 20 days is renewed
 * indefinitely, while a token that leaked stays bounded by the same 30d it always was (renewal
 * requires possession of a still-valid token — it is not a refresh token).
 */
export const TOKEN_RENEW_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Response header carrying a renewed token. Lower-case on purpose: it is compared against
 * `Headers.get()` (case-insensitive) on the web and against a manually lower-cased lookup in the
 * WeChat transport. Must also be listed in the CORS `exposedHeaders` (see metaserver/src/app.ts) or
 * no browser / WKWebView can read it and the whole mechanism silently does nothing.
 */
export const RENEWED_TOKEN_HEADER = 'x-nw-token';

export function signToken(accountId: string, cfg: JwtConfig): string {
  const opts: jwt.SignOptions = {
    expiresIn: (cfg.expiresIn ?? '30d') as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: accountId }, cfg.secret, opts);
}

/**
 * Verify the token and return the whole payload (`sub` + `exp`); throws on failure, same as
 * verifyToken. Callers that only need the accountId should keep using verifyToken — this exists for
 * the one caller that has to look at `exp` (metaserver's bearerAuth, for sliding renewal).
 */
export function verifyTokenPayload(token: string, cfg: JwtConfig): TokenPayload {
  const decoded = jwt.verify(token, cfg.secret);
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw new Error('invalid token payload');
  }
  const out: TokenPayload = { sub: decoded.sub };
  if (typeof decoded.exp === 'number') out.exp = decoded.exp;
  if (typeof decoded.iat === 'number') out.iat = decoded.iat;
  return out;
}

/** Verify the token and return accountId; throws on failure (caller maps to UNAUTHENTICATED). */
export function verifyToken(token: string, cfg: JwtConfig): string {
  return verifyTokenPayload(token, cfg).sub;
}

/** Extract the Bearer token from the Authorization header; returns null if absent. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
