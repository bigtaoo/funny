// Admin backend client for publishing map-template edits (SLG_DESIGN_LOG.md §24). Same Bearer-token/localStorage
// pattern as tools/ops/src/api.ts (the only other tool with an admin client) — no shared package exists between
// tools, so this is a deliberately small, scoped-down copy: only the map-template endpoints this tool needs.
import type { MapTemplateSummary, MapTemplateTile } from '@nw/shared/slg';

const API_KEY = 'nw_map_editor_admin_api';
const TOKEN_KEY = 'nw_map_editor_admin_token';

export interface Session {
  admin: { adminId: string; username: string; displayName: string; role: string };
  capabilities: string[];
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  private token: string | null = localStorage.getItem(TOKEN_KEY);
  onUnauthorized: (() => void) | null = null;

  get baseUrl(): string {
    const saved = localStorage.getItem(API_KEY);
    if (saved !== null) return saved;
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

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      if (res.status === 401 && path !== '/admin/login') {
        this.setToken(null);
        this.onUnauthorized?.();
      }
      throw new ApiError(res.status, code, msg);
    }
    return data as T;
  }

  async login(username: string, password: string): Promise<Session> {
    const r = await this.req<Session & { ok: true }>('POST', '/admin/login', { username, password });
    this.setToken(r.token);
    return r;
  }
  async me(): Promise<Pick<Session, 'admin' | 'capabilities'>> {
    return this.req('GET', '/admin/me');
  }
  async logout(): Promise<void> {
    try {
      await this.req('POST', '/admin/logout');
    } catch {
      /* ignore */
    }
    this.setToken(null);
  }

  // ── SLG map templates (§24; slg.map.view / slg.map.manage) ──────────────
  async listMapTemplates(): Promise<MapTemplateSummary[]> {
    const r = await this.req<{ templates: MapTemplateSummary[] }>('GET', '/admin/slg/map-templates');
    return r.templates;
  }
  async generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    const r = await this.req<{ template: MapTemplateSummary }>('POST', '/admin/slg/map-templates/generate', { templateId, width, height });
    return r.template;
  }
  async saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
    return this.req('PUT', `/admin/slg/map-templates/${encodeURIComponent(templateId)}/tiles`, { tiles });
  }
  async activateMapTemplate(templateId: string): Promise<void> {
    await this.req('POST', `/admin/slg/map-templates/${encodeURIComponent(templateId)}/activate`);
  }
  async deleteMapTemplate(templateId: string): Promise<void> {
    await this.req('DELETE', `/admin/slg/map-templates/${encodeURIComponent(templateId)}`);
  }
}
