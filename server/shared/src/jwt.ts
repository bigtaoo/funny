// Stateless JWT (SERVER_API.md §1.1). accountId is extracted from the token; the request body does not carry it.
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  /** accountId */
  sub: string;
}

export interface JwtConfig {
  secret: string;
  /** Expiry duration (zeit/ms string or seconds). Default: 30d. */
  expiresIn?: string | number;
}

export function signToken(accountId: string, cfg: JwtConfig): string {
  const opts: jwt.SignOptions = {
    expiresIn: (cfg.expiresIn ?? '30d') as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: accountId }, cfg.secret, opts);
}

/** Verify the token and return accountId; throws on failure (caller maps to UNAUTHENTICATED). */
export function verifyToken(token: string, cfg: JwtConfig): string {
  const decoded = jwt.verify(token, cfg.secret);
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw new Error('invalid token payload');
  }
  return decoded.sub;
}

/** Extract the Bearer token from the Authorization header; returns null if absent. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
