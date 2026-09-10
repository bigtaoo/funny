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
import { netLog, maybePromptAppeal, maybeNotifySessionExpired } from '../log';
import type { ApiResp } from './types';
import { clientPlatformName } from '../../app/appConstants';
import { getNativeBilling } from '../../platform/iap';
import { nativeShell } from '../../platform/nativeShell';
import { globalRequestGate } from '../rateGate';
import { netTransport, type NetResponse } from '../transport';

/** Milliseconds before an unresponsive metaserver request is aborted (mirrors WorldApiClient.req). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Sliding-renewal response header (server/shared/src/jwt.ts's RENEWED_TOKEN_HEADER — the two are a
 * pair, kept in sync by hand the same way every other cross-boundary string constant in this file
 * is). The metaserver attaches a freshly-signed token to any authenticated response whose token is
 * inside its last 10 days; adopting it here — the single choke point every REST call passes through
 * — is what turns a fixed 30d-from-last-password-entry session into a session that lasts as long as
 * the player keeps playing (ACCOUNT_DESIGN.md §5).
 */
const RENEWED_TOKEN_HEADER = 'x-nw-token';

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

  /**
   * Persistence outlet for a renewed token (see RENEWED_TOKEN_HEADER). The transport layer owns the
   * in-memory `token` but deliberately does NOT own storage: `nw_token` is written by the app layer
   * (`app/nav/auth.ts`'s doAuth on login, `doLogout` on the way out), and importing `platform` down
   * here to write it would give the transport a second, hidden owner of the same key. Registered
   * once by createAppCore; a renewal with no sink registered still updates the in-memory token, so
   * the session survives for as long as the process lives and only fails to outlive a restart.
   */
  onTokenRenewed: ((token: string) => void) | null = null;

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
      maybeNotifySessionExpired(json.error.code);
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
      const res = await netTransport().request({
        method,
        url: `${this.baseUrl}${path}`,
        headers,
        signal: ctrl.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      this.adoptRenewedToken(res);
      return res;
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

  /**
   * Swap in a token the server renewed for us. Runs on every response (including error ones — a
   * near-expiry token that hits e.g. INSUFFICIENT_FUNDS still deserves renewing) and is a no-op
   * whenever the header is absent, which is the overwhelming majority of responses.
   */
  private adoptRenewedToken(res: NetResponse): void {
    const renewed = res.headers?.get(RENEWED_TOKEN_HEADER);
    if (!renewed || renewed === this.token) return;
    log.info('token renewed by server');
    this.setToken(renewed);
    this.onTokenRenewed?.(renewed);
  }
}
