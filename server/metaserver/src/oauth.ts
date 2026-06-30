// Server-side OAuth authorization code flow implementation (SA-2).
// Initially supports Google (ACCOUNT_DESIGN §3). CSRF protection via state is handled by the client (localStorage comparison);
// by the time the server receives the code, state has already been consumed — the server does not need to persist state.
// To add more providers: add a case branch in exchangeCode and configure the corresponding env variables.

export type OAuthProvider = 'google';

export interface OAuthConfig {
  google?: {
    clientId: string;
    clientSecret: string;
  };
}

export interface OAuthSubResult {
  sub: string;
  email?: string;
}

/**
 * Exchange an authorization code for a sub (standard Google OAuth2 authorization code flow).
 * - POST /token to get access_token
 * - GET userinfo to retrieve sub + email
 * Uses fetch directly; no external dependencies.
 */
async function exchangeGoogle(
  code: string,
  redirectUri: string,
  cfg: NonNullable<OAuthConfig['google']>,
): Promise<OAuthSubResult> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new OAuthError(`Google token exchange failed (${tokenRes.status}): ${body}`);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokens.access_token) {
    throw new OAuthError(`Google token exchange: no access_token (${tokens.error ?? 'unknown'})`);
  }

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) {
    throw new OAuthError(`Google userinfo failed (${infoRes.status})`);
  }
  const info = (await infoRes.json()) as { sub?: string; email?: string };
  if (!info.sub) throw new OAuthError('Google userinfo: missing sub');
  return { sub: info.sub, email: info.email };
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export class OAuthService {
  constructor(private readonly config: OAuthConfig) {}

  /** Exchange an authorization code for an authenticated sub (provider-specific implementation). */
  async exchangeCode(
    provider: OAuthProvider,
    code: string,
    redirectUri: string,
  ): Promise<OAuthSubResult> {
    switch (provider) {
      case 'google': {
        const cfg = this.config.google;
        if (!cfg) throw new OAuthError('Google OAuth not configured (NW_OAUTH_GOOGLE_CLIENT_ID/SECRET missing)');
        return exchangeGoogle(code, redirectUri, cfg);
      }
      default:
        throw new OAuthError(`unsupported provider: ${provider}`);
    }
  }

  /** Whether a given provider is supported (credentials configured). */
  supports(provider: string): provider is OAuthProvider {
    return provider === 'google' && !!this.config.google;
  }
}

/** Build an OAuthService from process environment variables (called once at startup). */
export function createOAuthService(): OAuthService {
  const config: OAuthConfig = {};
  if (process.env.NW_OAUTH_GOOGLE_CLIENT_ID && process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET) {
    config.google = {
      clientId: process.env.NW_OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET,
    };
  }
  return new OAuthService(config);
}
