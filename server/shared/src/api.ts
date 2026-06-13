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
  ROOM_FULL: 'ROOM_FULL',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
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
  [ErrorCode.ROOM_FULL]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.INTERNAL]: 500,
};
