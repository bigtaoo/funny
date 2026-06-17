// admin 后端 REST 客户端（OPS_DESIGN §4.2）。Bearer admin token；不持任何内部密钥、不连库、
// 不直连业务服务——一切经 admin 后端（§7）。
import type {
  AdminAccountView,
  AuditEntryView,
  CompMailContent,
  CompScope,
  CompTarget,
  CompTicketView,
  LiveStats,
  PlayerProfile,
  Session,
  TrendPoint,
} from './types';

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

export class Api {
  private token: string | null = localStorage.getItem(TOKEN_KEY);
  /** 会话中途收到 401（token 过期/被禁用）时回调——上层据此弹回登录页。 */
  onUnauthorized: (() => void) | null = null;

  get baseUrl(): string {
    return localStorage.getItem(API_KEY) ?? 'http://localhost:18083';
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
      throw new ApiError(0, 'network', (e as Error).message || '网络错误');
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      const code = typeof data.code === 'string' ? data.code : String(res.status);
      const msg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      // 会话中途失效：清 token 并通知上层弹回登录页（登录请求本身的 401 = 凭证错，不弹）。
      if (res.status === 401 && path !== '/admin/login') {
        this.setToken(null);
        this.onUnauthorized?.();
      }
      throw new ApiError(res.status, code, msg);
    }
    return data as T;
  }

  // —— 认证 ——
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

  // —— 监控 / 分析 ——
  monitorLive(): Promise<LiveStats> {
    return this.req('GET', '/admin/monitor/live');
  }
  async trend(metric: string, fromMs?: number): Promise<TrendPoint[]> {
    const qs = new URLSearchParams({ metric });
    if (fromMs !== undefined) qs.set('from', String(fromMs));
    const r = await this.req<{ points: TrendPoint[] }>('GET', `/admin/monitor/trend?${qs}`);
    return r.points;
  }
  analyticsSummary(): Promise<{
    live: LiveStats;
    last24h: Record<string, { avg: number; peak: number; samples: number }>;
    tickets: Record<string, number>;
  }> {
    return this.req('GET', '/admin/analytics/summary');
  }
  analyticsEvents(type: string, days: number, platform?: string): Promise<{
    available: boolean;
    event_counts?: { date: string; event: string; count: number }[];
    dau?: { date: string; dau: number }[];
    funnel?: { date: string; platform: string; funnel_step: string; count: number; conversion_rate?: number }[];
    region_dist?: { locale: string; devices: number }[];
    os_dist?: { os: string; devices: number }[];
    login_hour?: { hour: number; count: number }[];
    retention?: { date: string; cohort_size: number; d1?: number; d7?: number; d1_rate?: number; d7_rate?: number }[];
  }> {
    const qs = new URLSearchParams({ type, days: String(days) });
    if (platform) qs.set('platform', platform);
    return this.req('GET', `/admin/analytics/events?${qs}`);
  }

  // —— 玩家 ——
  async player(publicId: string): Promise<PlayerProfile> {
    const r = await this.req<{ player: PlayerProfile }>('GET', `/admin/player/${encodeURIComponent(publicId)}`);
    return r.player;
  }

  // —— 补偿工单 ——
  async initiate(input: {
    scope: CompScope;
    target: CompTarget;
    mail: CompMailContent;
    reason: string;
  }): Promise<CompTicketView> {
    const r = await this.req<{ ticket: CompTicketView }>('POST', '/admin/comp/tickets', input);
    return r.ticket;
  }
  async tickets(status?: string): Promise<CompTicketView[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const r = await this.req<{ tickets: CompTicketView[] }>('GET', `/admin/comp/tickets${qs}`);
    return r.tickets;
  }
  async ticketAction(id: string, action: 'approve' | 'reject' | 'cancel' | 'retry', note?: string): Promise<CompTicketView> {
    const r = await this.req<{ ticket: CompTicketView }>(
      'POST',
      `/admin/comp/tickets/${encodeURIComponent(id)}/${action}`,
      action === 'reject' ? { note: note ?? '' } : undefined,
    );
    return r.ticket;
  }
  preview(scope: CompScope, target: CompTarget): Promise<{ recipientCount: number; available: boolean }> {
    return this.req('POST', '/admin/comp/preview', { scope, target });
  }

  // —— 审计 ——
  async audit(filter: { actor?: string; from?: number; to?: number }): Promise<AuditEntryView[]> {
    const qs = new URLSearchParams();
    if (filter.actor) qs.set('actor', filter.actor);
    if (filter.from !== undefined) qs.set('from', String(filter.from));
    if (filter.to !== undefined) qs.set('to', String(filter.to));
    const r = await this.req<{ entries: AuditEntryView[] }>('GET', `/admin/audit?${qs}`);
    return r.entries;
  }

  // —— 账号管理 ——
  async accounts(): Promise<AdminAccountView[]> {
    const r = await this.req<{ accounts: AdminAccountView[] }>('GET', '/admin/accounts');
    return r.accounts;
  }
  async createAccount(input: { username: string; password: string; role: string; displayName: string }): Promise<AdminAccountView> {
    const r = await this.req<{ account: AdminAccountView }>('POST', '/admin/accounts', input);
    return r.account;
  }
  async updateAccount(id: string, patch: { role?: string; disabled?: boolean; displayName?: string }): Promise<AdminAccountView> {
    const r = await this.req<{ account: AdminAccountView }>('PATCH', `/admin/accounts/${encodeURIComponent(id)}`, patch);
    return r.account;
  }
  async resetPassword(id: string, password: string): Promise<void> {
    await this.req('POST', `/admin/accounts/${encodeURIComponent(id)}/reset-password`, { password });
  }
}
