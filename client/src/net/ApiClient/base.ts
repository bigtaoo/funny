// Shared foundation for the ApiClient mixin chain (see ../ApiClient.ts assembly).
//
// ApiClientBase owns the constructor (baseUrl), the auth token field + setToken/getToken/hasToken,
// and the shared request()/fetchRaw() transport helpers (all `protected`, so the domain mixin bodies
// keep calling them verbatim: this.request(...), this.post(...), this.fetchRaw(...), this.token). Each
// REST domain (auth/save · pve/match · equipment · shop · gacha · social · mail · achievements · misc)
// lives in its own sibling file as `XMixin(Base)` and is chained into the final ApiClient.
//
// Transport uses the global fetch (natively supported by Web / CrazyGames). WeChat Mini Game has no fetch (uses wx.request) —
// its cloud sync is scheduled together with WeChat online compliance; currently SaveManager degrades to local-only (offline-first) when baseUrl / fetch is absent.
import { netLog } from '../log';
import type { ApiResp } from './types';

const log = netLog('api');

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClientBase {
  protected token: string | null = null;

  /** @param baseUrl e.g. https://host/api (no trailing slash). */
  constructor(protected readonly baseUrl: string) {}

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
  protected async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchRaw(method, path, body);
    const json = (await res.json()) as ApiResp<T>;
    if (!json.ok) {
      log.error(`${method} ${path} -> ${res.status} ${json.error.code}`, json.error.message);
      throw new ApiError(json.error.code, json.error.message);
    }
    log.info(`${method} ${path} -> ${res.status} ok`);
    return json.data;
  }

  protected async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    log.debug(`${method} ${path}`);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // Network-layer failure (server not running / CORS / DNS): fetch rejection is very generic in the console, so we log the URL explicitly here.
      log.error(`${method} ${path} network failure`, { url: `${this.baseUrl}${path}`, err: String(e) });
      throw e;
    }
  }
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type ApiClientBaseCtor = Constructor<ApiClientBase>;
