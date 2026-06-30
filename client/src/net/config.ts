// metaserver REST base URL resolution (S0-5).
// Priority: build-time injected global __NW_API_BASE__ > localStorage override (nw_api_base,
// for switching environments during integration testing) > null.
// Returns null → SaveManager degrades to local-only (offline-first), no requests sent.
//
// Format: https://host/api (no trailing slash). Caddy strips /api/* prefix and forwards to
// metaserver (see server/Caddyfile).

import type { IStorage } from '../platform/IPlatform';

const OVERRIDE_KEY = 'nw_api_base';

export function getApiBaseUrl(storage?: IStorage): string | null {
  const injected = (globalThis as { __NW_API_BASE__?: string }).__NW_API_BASE__;
  const override = storage?.getItem(OVERRIDE_KEY) ?? null;
  const raw = override || injected || '';
  if (!raw) return null;
  return raw.replace(/\/+$/, ''); // strip trailing slash
}

// gameserver WS endpoint resolution (S1-6). Same priority as the API: __NW_GAME_WS__ > localStorage(nw_game_ws) > derived from the API base URL.
// Format: wss://host/ws (no trailing slash, no query string). Caddy forwards /ws to gameserver (see server/Caddyfile).
// Returns null → no PvP multiplayer (NetClient does not connect).
const WS_OVERRIDE_KEY = 'nw_game_ws';

export function getGameWsUrl(storage?: IStorage): string | null {
  const injected = (globalThis as { __NW_GAME_WS__?: string }).__NW_GAME_WS__;
  const override = storage?.getItem(WS_OVERRIDE_KEY) ?? null;
  const explicit = (override || injected || '').replace(/\/+$/, '');
  if (explicit) return explicit;

  // Derived from the API base URL: https://host/api → wss://host/ws (same-origin deployment, unified Caddy reverse proxy).
  const api = getApiBaseUrl(storage);
  if (!api) return null;
  return api
    .replace(/^http/, 'ws') // http → ws, https → wss
    .replace(/\/api$/, '/ws');
}

// gateway control-plane WS endpoint resolution (S1-M4). Room / matchmaking traffic goes here;
// the lockstep data-plane game WS address is delivered at match start via match_found.game_url
// (no longer statically configured).
// Same priority as game: __NW_GATEWAY_WS__ > localStorage(nw_gateway_ws) > derived from API base URL at /gw.
// Returns null → no multiplayer (room UI can still open, but create/join shows "unavailable").
const GATEWAY_WS_OVERRIDE_KEY = 'nw_gateway_ws';

export function getGatewayWsUrl(storage?: IStorage): string | null {
  const injected = (globalThis as { __NW_GATEWAY_WS__?: string }).__NW_GATEWAY_WS__;
  const override = storage?.getItem(GATEWAY_WS_OVERRIDE_KEY) ?? null;
  const explicit = (override || injected || '').replace(/\/+$/, '');
  if (explicit) return explicit;

  const api = getApiBaseUrl(storage);
  if (!api) return null;
  return api.replace(/^http/, 'ws').replace(/\/api$/, '/gw');
}

// worldsvc REST base URL resolution (S8).
// Priority: build-time injected __NW_WORLD_BASE__ > '' (same-origin, Caddy forwards /world/* to worldsvc).
// Empty string in production when unconfigured (same-origin path); dev default: http://localhost:18084.
export function getWorldBaseUrl(): string {
  const injected = (globalThis as { __NW_WORLD_BASE__?: string }).__NW_WORLD_BASE__ ?? '';
  return injected.replace(/\/+$/, '');
}

// socialsvc REST base URL resolution (S6).
// Priority: build-time injected __NW_SOCIAL_BASE__ > '' (same-origin, Caddy forwards /social/* to socialsvc).
// Empty string in production when unconfigured (same-origin path); dev derives port 8085 from the same host as worldBase.
export function getSocialBaseUrl(): string {
  const injected = (globalThis as { __NW_SOCIAL_BASE__?: string }).__NW_SOCIAL_BASE__ ?? '';
  if (injected) return injected.replace(/\/+$/, '');
  const world = getWorldBaseUrl();
  if (!world) return ''; // production same-origin
  try {
    const u = new URL(world);
    u.port = '8085';
    u.pathname = '';
    return u.origin;
  } catch { return ''; }
}
