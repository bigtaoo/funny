// Shared foundation for the ApiClient composition (see ../ApiClient.ts assembly).
//
// ApiClientCore owns the constructor (baseUrl), the auth token field + setToken/getToken/hasToken,
// and the shared request()/fetchRaw() transport helpers (all `public` so the sibling domain classes
// below can call them via an injected `core` reference: this.core.request(...), this.core.post(...),
// this.core.token). Each REST domain (auth/save · pve/match · equipment · shop · gacha · social · mail ·
// achievements · misc) is its own independent class in a sibling file, constructed with `core` and
// composed into the final ApiClient facade (2026-08-11: converted from the former `XMixin(Base)`
// inheritance chain — zero cross-domain `this.*` calls, so this was pure file-splitting via a chain,
// see claudedocs/client-modules.md's split-form priority note).
//
// Transport goes through the net/transport.ts seam, not the global fetch directly: the WeChat mini-game
// runtime has no fetch at all and installs a wx.request-backed transport at boot (ASSET_PACKAGING §4.4).
// On Web / CrazyGames the seam's default is the global fetch, with the same init object this file used
// to build by hand. WeChat cloud sync itself is still scheduled together with WeChat online compliance;
// SaveManager degrades to local-only (offline-first) whenever baseUrl is absent, which is unchanged.
import { netLog, maybePromptAppeal } from '../log';
import type { ApiResp } from './types';
import { clientPlatformName } from '../../app/appConstants';
import { getNativeBilling } from '../../platform/iap';
import { nativeShell } from '../../platform/nativeShell';
import { globalRequestGate } from '../rateGate';
import { netTransport, type NetResponse } from '../transport';

/** Milliseconds before an unresponsive metaserver request is aborted (mirrors WorldApiClient.req). */
const FETCH_TIMEOUT_MS = 10_000;

const log = netLog('api');

/**
 * Request platform declared to the server (X-NW-Platform, ADR-020): which recharged-pool bucket this session
 * may spend from / display alongside the free pool (server/commercial/src/spendChannel.ts). A native shell
 * (Capacitor iOS/Android) injects `window.NWBilling` at runtime — the same signal `platform/iap.ts` uses to
 * route recharges to Apple/Google — so it's checked first.
 *
 * Then, before the build-time TARGET, comes Capacitor's own view of the platform (`platform/nativeShell.ts`).
 * TARGET cannot distinguish a native shell on its own — mobile reuses the web bundle, so it reads 'web' there
 * — and a shell whose bridge injection broke would otherwise declare itself a web session and spend from the
 * *web* (Paddle) bucket, which is the exact cross-channel leak ADR-020 exists to prevent. The shell knows what
 * it is even when the bridge is gone, so it answers here; the bridge is only needed to pick a *store*.
 */
export function requestPlatformHeader(): string {
  const native = getNativeBilling();
  if (native) return native.kind === 'apple' ? 'ios' : 'android';
  return nativeShell() ?? clientPlatformName();
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClientCore {
  token: string | null = null;

  /** @param baseUrl e.g. https://host/api (no trailing slash). */
  constructor(readonly baseUrl: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  // ── Internal ────────────────────────────────────────────────
  async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, body, extraHeaders);
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const res = await this.fetchRaw(method, path, body, extraHeaders);
    const json = (await res.json()) as ApiResp<T>;
    if (!json.ok) {
      log.error(`${method} ${path} -> ${res.status} ${json.error.code}`, json.error.message);
      maybePromptAppeal(json.error.code);
      throw new ApiError(json.error.code, json.error.message);
    }
    log.info(`${method} ${path} -> ${res.status} ok`);
    return json.data;
  }

  async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<NetResponse> {
    const headers: Record<string, string> = {
      'x-nw-platform': requestPlatformHeader(),
      ...extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    log.debug(`${method} ${path}`);
    await globalRequestGate.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await netTransport().request({
        method,
        url: `${this.baseUrl}${path}`,
        headers,
        signal: ctrl.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      // Network-layer failure (server not running / CORS / DNS / timeout abort): the transport's
      // rejection is very generic in the console, so we log the URL explicitly here.
      log.error(`${method} ${path} network failure`, {
        url: `${this.baseUrl}${path}`,
        err: String(e),
      });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
