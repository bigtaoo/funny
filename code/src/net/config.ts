// metaserver REST 基址解析（S0-5）。
// 优先级：构建期注入的全局 __NW_API_BASE__ > localStorage 覆盖（nw_api_base，便于联调切环境）> null。
// 返回 null → SaveManager 退化为纯本地（离线优先），不发任何请求。
//
// 形如 https://host/api（无尾斜杠）。Caddy 把 /api/* 剥前缀转 metaserver（见 server/Caddyfile）。

import type { IStorage } from '../platform/IPlatform';

const OVERRIDE_KEY = 'nw_api_base';

export function getApiBaseUrl(storage?: IStorage): string | null {
  const injected = (globalThis as { __NW_API_BASE__?: string }).__NW_API_BASE__;
  const override = storage?.getItem(OVERRIDE_KEY) ?? null;
  const raw = override || injected || '';
  if (!raw) return null;
  return raw.replace(/\/+$/, ''); // 去尾斜杠
}
