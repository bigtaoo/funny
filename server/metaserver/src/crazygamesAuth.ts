// CrazyGames portal SSO (RETENTION_LAUNCH_PLAN.md §1.1/§3.1): server-side verification of the JWT
// returned by the client's `SDK.user.getUserToken()`. This is a THIRD PARTY's signature — verified
// against CrazyGames' own published public key, never our own `NW_JWT_SECRET` (that key signs OUR
// tokens for OUR clients; CrazyGames' key signs THEIR tokens for every game on their portal).
// Docs: https://docs.crazygames.com/sdk/html5-v2/user/ — "User Module", "JWT Verification".
import jwt from 'jsonwebtoken';

const PUBLIC_KEY_URL = 'https://sdk.crazygames.com/publicKey.json';

export interface CrazyGamesTokenPayload {
  userId: string;
  gameId: string;
  username?: string;
  profilePictureUrl?: string;
}

export class CrazyGamesAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrazyGamesAuthError';
  }
}

export interface CrazyGamesAuthConfig {
  /** This game's CrazyGames dashboard-assigned game id — a token minted for a DIFFERENT game on the
   *  portal must not verify here (same public key signs every game's tokens). */
  gameId: string;
}

// Process-lifetime cache: fetched once, re-fetched only on a verify failure (CrazyGames' own
// recommendation — the key can rotate without notice, and a login attempt is rare enough that
// "one extra fetch on failure" costs nothing compared to caching forever and silently locking
// every player out after a rotation).
let cachedKey: string | undefined;

async function fetchPublicKey(): Promise<string> {
  const res = await fetch(PUBLIC_KEY_URL);
  if (!res.ok) throw new CrazyGamesAuthError(`failed to fetch CrazyGames public key (${res.status})`);
  const body = (await res.json()) as { publicKey?: string };
  if (!body.publicKey) throw new CrazyGamesAuthError('CrazyGames public key response missing publicKey');
  return body.publicKey;
}

/** Test-only hook: inject a key directly instead of hitting the network, and reset the module cache. */
export function __setPublicKeyForTest(key: string | undefined): void {
  cachedKey = key;
}

/**
 * Verify a CrazyGames SDK user token (RS256) and return its decoded payload.
 * Throws {@link CrazyGamesAuthError} for any failure (fetch, signature, expiry, gameId mismatch) —
 * callers only need one catch, same shape as `OAuthService.exchangeCode`'s `OAuthError`.
 */
export async function verifyCrazyGamesToken(
  token: string,
  cfg: CrazyGamesAuthConfig,
): Promise<CrazyGamesTokenPayload> {
  const verify = (key: string) => jwt.verify(token, key, { algorithms: ['RS256'] }) as CrazyGamesTokenPayload;

  let payload: CrazyGamesTokenPayload;
  try {
    if (!cachedKey) cachedKey = await fetchPublicKey();
    payload = verify(cachedKey);
  } catch {
    // One retry with a freshly fetched key — covers both "key rotated" and "we never fetched it yet
    // and the first attempt above threw for an unrelated reason". A genuinely invalid/expired token
    // still fails the same way with a fresh key, so this never masks a real rejection.
    try {
      cachedKey = await fetchPublicKey();
      payload = verify(cachedKey);
    } catch {
      throw new CrazyGamesAuthError('invalid or expired CrazyGames token');
    }
  }

  if (!payload.userId) throw new CrazyGamesAuthError('CrazyGames token missing userId');
  if (payload.gameId !== cfg.gameId) throw new CrazyGamesAuthError('CrazyGames token gameId mismatch');
  return payload;
}

/** Build a CrazyGamesAuthConfig from process environment variables (called once at startup), or
 *  `undefined` if unconfigured — mirrors `createOAuthService`'s per-provider optionality. */
export function createCrazyGamesAuthConfig(): CrazyGamesAuthConfig | undefined {
  const gameId = process.env.NW_CRAZYGAMES_GAME_ID;
  return gameId ? { gameId } : undefined;
}
