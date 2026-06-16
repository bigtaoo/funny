// 统一响应包络 + 错误码（SERVER_API.md §1.2 / §1.3）。

export type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REV_CONFLICT: 'REV_CONFLICT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  DAILY_CAP_REACHED: 'DAILY_CAP_REACHED',
  INVALID_RECEIPT: 'INVALID_RECEIPT',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
  // —— 账号系统（SA-1/SA-2）——
  LOGIN_ID_TAKEN: 'LOGIN_ID_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ALREADY_BOUND: 'ALREADY_BOUND',
  OAUTH_FAILED: 'OAUTH_FAILED',
  // —— 社交系统（S6，SOCIAL_DESIGN §5）——
  FRIEND_CAP_REACHED: 'FRIEND_CAP_REACHED',
  ALREADY_FRIEND: 'ALREADY_FRIEND',
  NOT_FRIEND: 'NOT_FRIEND',
  BLOCKED: 'BLOCKED',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  NO_ATTACHMENT: 'NO_ATTACHMENT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function err(code: ErrorCode, message: string): {
  ok: false;
  error: { code: string; message: string };
} {
  return { ok: false, error: { code, message } };
}

/** HTTP 状态码 → 错误码的约定映射（SERVER_API.md §2 标注的状态码）。 */
export const ERROR_HTTP_STATUS: Record<string, number> = {
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.REV_CONFLICT]: 409,
  [ErrorCode.INSUFFICIENT_FUNDS]: 402,
  [ErrorCode.DAILY_CAP_REACHED]: 429,
  [ErrorCode.INVALID_RECEIPT]: 400,
  [ErrorCode.ROOM_NOT_FOUND]: 404,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ROOM_FULL]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.INTERNAL]: 500,
  [ErrorCode.LOGIN_ID_TAKEN]: 409,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.WEAK_PASSWORD]: 400,
  [ErrorCode.ALREADY_BOUND]: 409,
  [ErrorCode.OAUTH_FAILED]: 400,
  [ErrorCode.FRIEND_CAP_REACHED]: 409,
  [ErrorCode.ALREADY_FRIEND]: 409,
  [ErrorCode.NOT_FRIEND]: 403,
  [ErrorCode.BLOCKED]: 403,
  [ErrorCode.ALREADY_CLAIMED]: 409,
  [ErrorCode.NO_ATTACHMENT]: 400,
};
