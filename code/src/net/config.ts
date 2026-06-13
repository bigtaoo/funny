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

// gameserver WS 端点解析（S1-6）。优先级与 API 同：__NW_GAME_WS__ > localStorage(nw_game_ws) > 由 API 基址推导。
// 形如 wss://host/ws（无尾斜杠、无 query）。Caddy 把 /ws 转 gameserver（见 server/Caddyfile）。
// 返回 null → 无 PvP 联机（NetClient 不连）。
const WS_OVERRIDE_KEY = 'nw_game_ws';

export function getGameWsUrl(storage?: IStorage): string | null {
  const injected = (globalThis as { __NW_GAME_WS__?: string }).__NW_GAME_WS__;
  const override = storage?.getItem(WS_OVERRIDE_KEY) ?? null;
  const explicit = (override || injected || '').replace(/\/+$/, '');
  if (explicit) return explicit;

  // 由 API 基址推导：https://host/api → wss://host/ws（同源部署，Caddy 统一反代）。
  const api = getApiBaseUrl(storage);
  if (!api) return null;
  return api
    .replace(/^http/, 'ws') // http→ws, https→wss
    .replace(/\/api$/, '/ws');
}
