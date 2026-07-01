// Admin backend REST client (OPS_DESIGN §4.2). Bearer admin token; holds no internal secrets, connects to
// no database, and never reaches business services directly — everything goes through the admin backend (§7).
import type {
  AdminAccountView,
  AntiCheatReviewView,
  AuditEntryView,
  AuctionAnomaly,
  CompMailContent,
  CompScope,
  CompTarget,
  CompTicketView,
  EventDoc,
  EventInput,
  FeatureFlagDoc,
  FeatureFlagRow,
  FlagRollout,
  LiveStats,
  PlayerProfile,
  PlayerSummary,
  Session,
  SlgWorldSummary,
  TradeAuditSnapshot,
  TradeAuditTicketView,
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
      // Mid-session expiry: clear the token and notify the caller to show the login page (a 401 on the login request itself means bad credentials — do not redirect).
      if (res.status === 401 && path !== '/admin/login') {
        this.setToken(null);
        this.onUnauthorized?.();
      }
      throw new ApiError(res.status, code, msg);
    }
    return data as T;
  }

  // —— Authentication ——
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

  // —— Monitoring / Analytics ——
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

  // —— Players ——
  async player(publicId: string): Promise<PlayerProfile> {
    const r = await this.req<{ player: PlayerProfile }>('GET', `/admin/player/${encodeURIComponent(publicId)}`);
    return r.player;
  }

  async playerByAccount(accountId: string): Promise<PlayerProfile> {
    const r = await this.req<{ player: PlayerProfile }>('GET', `/admin/player/account/${encodeURIComponent(accountId)}`);
    return r.player;
  }

  async searchPlayers(q: string): Promise<PlayerSummary[]> {
    const r = await this.req<{ players: PlayerSummary[] }>('GET', `/admin/players/search?q=${encodeURIComponent(q)}`);
    return r.players;
  }

  // —— Achievement anti-cheat review queue (S9-7) ——
  async antiCheatReviews(opts?: { accountId?: string; status?: string; limit?: number }): Promise<AntiCheatReviewView[]> {
    const qs = new URLSearchParams();
    if (opts?.accountId) qs.set('accountId', opts.accountId);
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const r = await this.req<{ reviews: AntiCheatReviewView[] }>('GET', `/admin/anticheat/reviews?${qs}`);
    return r.reviews;
  }

  // —— Compensation tickets ——
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

  // —— Audit ——
  async audit(filter: { actor?: string; from?: number; to?: number }): Promise<AuditEntryView[]> {
    const qs = new URLSearchParams();
    if (filter.actor) qs.set('actor', filter.actor);
    if (filter.from !== undefined) qs.set('from', String(filter.from));
    if (filter.to !== undefined) qs.set('to', String(filter.to));
    const r = await this.req<{ entries: AuditEntryView[] }>('GET', `/admin/audit?${qs}`);
    return r.entries;
  }

  // —— Ladder season operations ——
  async ladderGetCurrentSeason(): Promise<{ seasonNo: number; startAt: number; endAt: number; state: string } | null> {
    const r = await this.req<{ season: { seasonNo: number; startAt: number; endAt: number; state: string } | null }>('GET', '/admin/ladder/season/current');
    return r.season;
  }
  async ladderRollSeason(): Promise<{ seasonNo: number; startAt: number; endAt: number; state: string }> {
    const r = await this.req<{ season: { seasonNo: number; startAt: number; endAt: number; state: string } }>('POST', '/admin/ladder/season/roll');
    return r.season;
  }

  // —— Account management ——
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

  // ── Feature flags (config.manage) ──
  async flags(): Promise<FeatureFlagRow[]> {
    const r = await this.req<{ flags: FeatureFlagRow[] }>('GET', '/admin/config/flags');
    return r.flags;
  }
  async upsertFlag(key: string, input: { enabled: boolean; rollout?: FlagRollout; desc?: string }): Promise<FeatureFlagDoc> {
    const r = await this.req<{ flag: FeatureFlagDoc }>('PUT', `/admin/config/flags/${encodeURIComponent(key)}`, input);
    return r.flag;
  }

  // ── Timed event management (events.manage) ──
  async events(): Promise<EventDoc[]> {
    const r = await this.req<{ events: EventDoc[] }>('GET', '/admin/events');
    return r.events;
  }
  async createEvent(input: EventInput): Promise<EventDoc> {
    const r = await this.req<{ event: EventDoc }>('POST', '/admin/events', input);
    return r.event;
  }
  async updateEvent(id: string, input: EventInput): Promise<EventDoc> {
    const r = await this.req<{ event: EventDoc }>('PATCH', `/admin/events/${encodeURIComponent(id)}`, input);
    return r.event;
  }
  async deleteEvent(id: string): Promise<void> {
    await this.req('DELETE', `/admin/events/${encodeURIComponent(id)}`);
  }

  // ── SLG season ops (G7/§17.7; slg.season.view / slg.season.manage) ──
  async slgListWorlds(): Promise<SlgWorldSummary[]> {
    const r = await this.req<{ worlds: SlgWorldSummary[] }>('GET', '/admin/slg/worlds');
    return r.worlds;
  }
  async slgOpenSeason(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.req('POST', '/admin/slg/season/open', { worldId, season, shard, capacity });
  }
  async slgSettleSeason(worldId: string): Promise<unknown> {
    const r = await this.req<{ ranking: unknown }>('POST', '/admin/slg/season/settle', { worldId });
    return r.ranking;
  }
  async slgResetSeason(worldId: string): Promise<void> {
    await this.req('POST', '/admin/slg/season/reset', { worldId });
  }
  async slgCloseSeason(worldId: string): Promise<void> {
    await this.req('POST', '/admin/slg/season/close', { worldId });
  }

  // ── SLG anomalous trade audit (G7 anti-RMT; slg.audit.view / slg.audit.manage) ──
  async slgScanAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]> {
    const qs = new URLSearchParams({ worldId });
    if (windowSec !== undefined) qs.set('windowSec', String(windowSec));
    const r = await this.req<{ anomalies: AuctionAnomaly[] }>('GET', `/admin/slg/audit/anomalies?${qs}`);
    return r.anomalies;
  }
  async slgListAuditTickets(status?: string): Promise<TradeAuditTicketView[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const r = await this.req<{ tickets: TradeAuditTicketView[] }>('GET', `/admin/slg/audit/tickets${qs}`);
    return r.tickets;
  }
  async slgFileAuditTicket(snapshot: TradeAuditSnapshot): Promise<TradeAuditTicketView> {
    const r = await this.req<{ ticket: TradeAuditTicketView }>('POST', '/admin/slg/audit/tickets', { snapshot });
    return r.ticket;
  }
  async slgResolveAuditTicket(id: string, disposition: 'dismissed' | 'actioned', note?: string): Promise<TradeAuditTicketView> {
    const r = await this.req<{ ticket: TradeAuditTicketView }>(
      'POST',
      `/admin/slg/audit/tickets/${encodeURIComponent(id)}/resolve`,
      { disposition, note: note ?? '' },
    );
    return r.ticket;
  }
}
