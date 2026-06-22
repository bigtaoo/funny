// OAuth 授权码流服务端实现（SA-2）。
// 首期支持 Google（ACCOUNT_DESIGN §3）。state 防 CSRF 由客户端 localStorage 比对，
// 服务端接 code 时 state 已消费；服务端无需持久化 state。
// 扩展更多 provider：在 exchangeCode 加 case 分支，配对应 env 变量即可。

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
 * 用授权码换 sub（Google OAuth2 标准授权码流）。
 * - POST /token 换 access_token
 * - GET userinfo 取 sub + email
 * 直接用 fetch，零外部依赖。
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

  /** 用授权码换已认证的 sub（provider-specific 实现）。 */
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

  /** 是否支持某 provider（已配置凭据）。 */
  supports(provider: string): provider is OAuthProvider {
    return provider === 'google' && !!this.config.google;
  }
}

/** 从进程环境变量构建 OAuthService（首次调用时）。 */
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
