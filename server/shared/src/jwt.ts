// 无状态 JWT（SERVER_API.md §1.1）。accountId 由 token 解出，请求体不带。
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  /** accountId */
  sub: string;
}

export interface JwtConfig {
  secret: string;
  /** 过期时间（zeit/ms 字符串或秒数），默认 30d。 */
  expiresIn?: string | number;
}

export function signToken(accountId: string, cfg: JwtConfig): string {
  const opts: jwt.SignOptions = {
    expiresIn: (cfg.expiresIn ?? '30d') as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: accountId }, cfg.secret, opts);
}

/** 校验并返回 accountId；失败抛错（调用方转 UNAUTHENTICATED）。 */
export function verifyToken(token: string, cfg: JwtConfig): string {
  const decoded = jwt.verify(token, cfg.secret);
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw new Error('invalid token payload');
  }
  return decoded.sub;
}

/** 从 Authorization 头取 Bearer token；无则返回 null。 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
