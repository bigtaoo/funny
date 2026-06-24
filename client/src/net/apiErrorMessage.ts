// 未捕获 API / 网络错误 → 玩家可读文案（全局兜底，GlobalToast 用）。
//
// 背景：ApiClient / WorldApiClient 对非 200 回复会抛 ApiError / WorldApiError，正常路径下
// 各场景自行 catch 并 toast。本模块只处理「场景漏接、一路冒泡到 window 的未捕获拒绝」——
// installGlobalErrorHandlers 把 reason 交到这里归类，能识别为 API / 网络错误的才弹兜底提示，
// 其余（普通 JS 异常）返回 null，调用方跳过弹窗（仍照常打 console）。
//
// 刻意用 duck-typing（按 err.name + err.code）而非 import 具体错误类：log.ts 是最底层模块，
// 直接依赖 ApiClient / WorldApiClient 会形成循环依赖。

import { t, type TranslationKey } from '../i18n';

/** 已知错误码 → 友好文案 key。未列出的码统一落 common.actionFailed。 */
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
 * 把一个未捕获的 rejection / error 归类为玩家可读文案。
 * - ApiError / WorldApiError（带字符串 code）→ 按码映射，未知码 → 通用「操作失败」。
 * - 网络层失败（fetch reject 通常是 TypeError）→「网络连接失败」。
 * - withTimeout 的 TimeoutError → 「网络超时」（正常都在场景内被接住，这里兜底）。
 * - 其余普通异常 → null（不弹兜底，避免把 JS bug 当成业务提示吓到玩家）。
 */
export function uncaughtErrorMessage(reason: unknown): string | null {
  // fetch 网络失败：浏览器 reject 成 TypeError（断网 / CORS / DNS）。
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
