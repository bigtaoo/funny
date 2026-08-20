// Wire plumbing for the ops admin REST client, split out of api.ts on 2026-08-20 to clear the
// 500-line convention gate (ADR-067; tools/scripts/checkFileLength.mjs). Nothing moved semantically:
// this is the transport half — base URL resolution, the Bearer token in localStorage, the single
// fetch wrapper and its error mapping — while api.ts keeps the endpoint surface, the half that
// actually grows every time a page is added. `ApiError` lives here because `req` is what throws it,
// and api.ts re-exports it so every existing `from './api'` / `from '../api'` import is unchanged.

const API_KEY = 'nw_admin_api';
const TOKEN_KEY = 'nw_admin_token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export abstract class ApiTransport {
  private token: string | null = localStorage.getItem(TOKEN_KEY);
  /** Called when a 401 is received mid-session (token expired or disabled) — the caller redirects to the login page. */
  onUnauthorized: (() => void) | null = null;

  get baseUrl(): string {
    const saved = localStorage.getItem(API_KEY);
    if (saved !== null) return saved;
    // Default: local dev connects to the local admin (18083); production is same-origin (empty string → relative
    // path /admin/*, reverse-proxied by the ops Worker to the admin backend protected by CF Access + shared secret,
    // see deploy-cloudflare.md §6).
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ? 'http://localhost:18083' : '';
  }
  setBaseUrl(url: string): void {
    localStorage.setItem(API_KEY, url.replace(/\/$/, ''));
  }
  setToken(t: string | null): void {
    this.token = t;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }
  get hasToken(): boolean {
    return !!this.token;
  }

  protected async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ApiError(0, 'network', (e as Error).message || 'Network error');
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      const code = typeof data.code === 'string' ? data.code : String(res.status);
      const msg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      // Mid-session expiry: clear the token and notify the caller to show the login page (a 401 on the login request itself means bad credentials — do not redirect).
      if (res.status === 401 && path !== '/admin/login') {
        this.setToken(null);
        this.onUnauthorized?.();
      }
      throw new ApiError(res.status, code, msg);
    }
    return data as T;
  }
}
