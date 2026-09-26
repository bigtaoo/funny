// Shared error shape for botsvc's public-REST clients (socialClient / worldClient).
//
// Every service answers a business failure with the `err()` envelope from @nw/shared:
// `{ ok: false, error: { code, message } }`. The clients used to do `new Error(parsed.error)`, which
// stringifies that object — so for months the only thing botsvc's rolled-up failure log could say
// about 1.2M failed family calls was `last: [object Object]`. Keeping `code` lets callers branch on
// expected races (FAMILY_FULL, ALREADY_REQUESTED, …) instead of string-matching messages.

export class BotApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BotApiError';
  }
}

/** Turns a parsed `{ok:false}` envelope into a BotApiError, tolerating the older bare-string `error` form. */
export function envelopeError(error: unknown, fallback: string): BotApiError {
  if (typeof error === 'string') return new BotApiError(error, error);
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const c = typeof code === 'string' ? code : 'UNKNOWN';
    return new BotApiError(c, typeof message === 'string' ? message : c);
  }
  return new BotApiError('UNKNOWN', fallback);
}

/** True when `e` is a BotApiError carrying one of `codes`. */
export function hasCode(e: unknown, ...codes: string[]): boolean {
  return e instanceof BotApiError && codes.includes(e.code);
}
