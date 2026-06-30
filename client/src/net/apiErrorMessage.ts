// Uncaught API / network errors → player-readable message (global fallback, used by GlobalToast).
//
// Background: ApiClient / WorldApiClient throw ApiError / WorldApiError on non-200 responses;
// in the normal flow each scene catches and toasts them itself. This module only handles
// uncaught rejections that bubble all the way to window —
// installGlobalErrorHandlers passes the reason here for classification; only errors
// recognised as API / network errors trigger a fallback toast, all others (plain JS
// exceptions) return null so the caller skips the popup (but still logs to console).
//
// Intentionally uses duck-typing (err.name + err.code) rather than importing concrete
// error classes: log.ts is the lowest-level module, and directly depending on ApiClient /
// WorldApiClient would create a circular dependency.

import { t, type TranslationKey } from '../i18n';

/** Known error codes → friendly i18n key. Unlisted codes fall back to common.actionFailed. */
const CODE_KEY: Partial<Record<string, TranslationKey>> = {
  INSUFFICIENT_FUNDS:     'common.err.insufficientFunds',
  INSUFFICIENT_MATERIALS: 'common.err.insufficientFunds',
  INSUFFICIENT_RESOURCES: 'common.err.insufficientFunds',
  RATE_LIMITED:           'common.err.rateLimited',
  DAILY_CAP_REACHED:      'common.err.rateLimited',
  UNAUTHORIZED:           'common.err.unauthorized',
  TOKEN_EXPIRED:          'common.err.unauthorized',
  FORBIDDEN:              'common.err.unauthorized',
  NOT_FOUND:              'common.err.notFound',
};

/**
 * Classify an uncaught rejection / error as a player-readable message.
 * - ApiError / WorldApiError (with a string code) → mapped by code; unknown code → generic "action failed".
 * - Network-layer failure (fetch rejection, usually TypeError) → "network connection failed".
 * - withTimeout's TimeoutError → "network timeout" (normally caught inside scenes; this is the fallback).
 * - All other plain exceptions → null (no fallback popup, to avoid scaring players with JS bugs).
 */
export function uncaughtErrorMessage(reason: unknown): string | null {
  // fetch network failure: browser rejects as TypeError (offline / CORS / DNS).
  if (reason instanceof TypeError) return t('common.networkError');

  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    if (
      (reason.name === 'ApiError' || reason.name === 'WorldApiError') &&
      typeof code === 'string'
    ) {
      return CODE_KEY[code] ? t(CODE_KEY[code]!) : t('common.actionFailed');
    }
    if (reason.name === 'TimeoutError' || reason.message === 'timeout') {
      return t('common.networkTimeout');
    }
  }
  return null;
}
