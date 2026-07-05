// Internal calls from admin to business services (OPS_DESIGN §4.1). admin holds X-Internal-Key as a privileged internal caller.
// Same shape as commercialClient / gatewayClient: HTTP implementation + interface (easy to inject fakes in tests).
import {
  createLogger,
  internalHeaders,
  type AntiCheatReviewDoc,
  type AuctionAnomaly,
  type CompAttachment,
  type CompTarget,
  type EventDoc,
  type EventInput,
  type LiveStats,
  type GachaCategory,
  type GachaCatalogItem,
  type CustomPoolConfig,
  type MapTemplateSummary,
  type MapTemplateTile,
} from '@nw/shared';

const log = createLogger('admin:clients');

// ── Stats (gateway / matchsvc) ────────────────────────────
export interface StatsClient {
  readonly available: boolean;
  /** Fetches one aggregated live snapshot; returns zeros if unavailable or on error (sampling must not block). */
  fetchLive(): Promise<LiveStats>;
}

interface GatewayStats {
  online: number;
}
interface MatchsvcStats {
  queue: number;
  rooms: number;
  gameInstances: number;
  gameLoad: number;
}

/** Merges GET /internal/stats from gateway + matchsvc. Fields from any unavailable service default to 0. */
export class HttpStatsClient implements StatsClient {
  constructor(
    private readonly gatewayUrl: string | null,
    private readonly matchsvcUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.gatewayUrl !== null || this.matchsvcUrl !== null;
  }

  async fetchLive(): Promise<LiveStats> {
    const [gw, mm] = await Promise.all([this.gateway(), this.matchsvc()]);
    return {
      online: gw?.online ?? 0,
      queue: mm?.queue ?? 0,
      rooms: mm?.rooms ?? 0,
      gameInstances: mm?.gameInstances ?? 0,
      gameLoad: mm?.gameLoad ?? 0,
    };
  }

  private async gateway(): Promise<GatewayStats | null> {
    if (!this.gatewayUrl) return null;
    return this.get<GatewayStats>(`${this.gatewayUrl}/internal/stats`, 'gateway');
  }
  private async matchsvc(): Promise<MatchsvcStats | null> {
    if (!this.matchsvcUrl) return null;
    return this.get<MatchsvcStats>(`${this.matchsvcUrl}/internal/stats`, 'matchsvc');
  }

  private async get<T>(url: string, tag: string): Promise<T | null> {
    try {
      const res = await fetch(url, { headers: internalHeaders('admin', this.internalKey) });
      if (!res.ok) {
        log.warn('stats fetch non-2xx', { tag, status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      log.warn('stats fetch failed', { tag, err: (e as Error).message });
      return null;
    }
  }
}

// ── Player lookup (meta, player.lookup) ────────────────────
export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
}

/** Fuzzy search hit row (= meta AccountSearchRow, shown in OPS list views). */
export interface PlayerSummary {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

export interface PlayerClient {
  readonly available: boolean;
  /** Look up a player profile by 9-digit public id; returns null if not found. */
  lookupByPublicId(publicId: string): Promise<PlayerProfile | null>;
  /** Look up a player profile by accountId; returns null if not found. */
  lookupByAccountId(accountId: string): Promise<PlayerProfile | null>;
  /** Fuzzy search (display name / login id / public id / accountId); returns a list of matching summaries. */
  search(q: string, limit: number): Promise<PlayerSummary[]>;
}

export class HttpPlayerClient implements PlayerClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async lookupByPublicId(publicId: string): Promise<PlayerProfile | null> {
    return this.lookup(`publicId=${encodeURIComponent(publicId)}`);
  }

  async lookupByAccountId(accountId: string): Promise<PlayerProfile | null> {
    return this.lookup(`accountId=${encodeURIComponent(accountId)}`);
  }

  private async lookup(qs: string): Promise<PlayerProfile | null> {
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/player?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.warn('player lookup non-2xx', { status: res.status });
        return null;
      }
      return (await res.json()) as PlayerProfile;
    } catch (e) {
      log.warn('player lookup failed', { err: (e as Error).message });
      return null;
    }
  }

  async search(q: string, limit: number): Promise<PlayerSummary[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const res = await fetch(
        `${this.metaBaseUrl}/internal/players/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        { headers: internalHeaders('admin', this.internalKey) },
      );
      if (!res.ok) {
        log.warn('player search non-2xx', { status: res.status });
        return [];
      }
      return ((await res.json()) as { players: PlayerSummary[] }).players;
    } catch (e) {
      log.warn('player search failed', { err: (e as Error).message });
      return [];
    }
  }
}

// ── Achievement anti-cheat review queue (meta /internal/anticheat/reviews, S9-7) ──────────────
/** Review record view (= meta AntiCheatReviewDoc, read-only display in OPS). */
export type AntiCheatReviewRow = AntiCheatReviewDoc;

export interface AntiCheatClient {
  readonly available: boolean;
  /** List anti-cheat review records (defaults to open status); returns empty array if unavailable or on error. */
  listReviews(opts?: { accountId?: string; status?: string; limit?: number }): Promise<AntiCheatReviewRow[]>;
}

export class HttpAntiCheatClient implements AntiCheatClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listReviews(opts?: { accountId?: string; status?: string; limit?: number }): Promise<AntiCheatReviewRow[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const qs = new URLSearchParams();
      if (opts?.accountId) qs.set('accountId', opts.accountId);
      if (opts?.status) qs.set('status', opts.status);
      if (opts?.limit) qs.set('limit', String(opts.limit));
      const res = await fetch(`${this.metaBaseUrl}/internal/anticheat/reviews?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('anticheat reviews non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { reviews?: AntiCheatReviewRow[] };
      return body.reviews ?? [];
    } catch (e) {
      log.warn('anticheat reviews failed', { err: (e as Error).message });
      return [];
    }
  }
}

// ── hash mismatch query (C3) ──────────────────────────────────
export interface MismatchRow {
  roomId: string;
  mode: string;
  players: { side: number; accountId: string }[];
  reason: string;
  ts: number;
}

export interface MismatchClient {
  readonly available: boolean;
  listMismatches(): Promise<MismatchRow[]>;
}

export class HttpMismatchClient implements MismatchClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listMismatches(): Promise<MismatchRow[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mismatches`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('mismatches non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { matches?: MismatchRow[] };
      return body.matches ?? [];
    } catch (e) {
      log.warn('mismatches fetch failed', { err: (e as Error).message });
      return [];
    }
  }
}

// ── C4 suspicious PvE accounts (/internal/suspicious-pve) ───────────
export interface SuspiciousPveRow {
  _id: string;
  displayName?: string;
  publicId?: string;
  pveWarnings: number;
  banned: boolean;
  createdAt: number;
}

export interface SuspiciousPveClient {
  readonly available: boolean;
  listSuspiciousPve(): Promise<SuspiciousPveRow[]>;
  banAccount(accountId: string): Promise<{ ok: boolean }>;
  unbanAccount(accountId: string): Promise<{ ok: boolean }>;
}

export class HttpSuspiciousPveClient implements SuspiciousPveClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listSuspiciousPve(): Promise<SuspiciousPveRow[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/suspicious-pve`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('suspicious-pve non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as {
        accounts?: { _id: string; displayName?: string; publicId?: string; flags?: { pveWarnings?: number; banned?: boolean }; createdAt: number }[];
      };
      return (body.accounts ?? []).map((a) => ({
        _id: a._id,
        displayName: a.displayName,
        publicId: a.publicId,
        pveWarnings: a.flags?.pveWarnings ?? 0,
        banned: a.flags?.banned ?? false,
        createdAt: a.createdAt,
      }));
    } catch (e) {
      log.warn('suspicious-pve fetch failed', { err: (e as Error).message });
      return [];
    }
  }

  async banAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/ban`, {
        method: 'POST',
        headers: internalHeaders('admin', this.internalKey),
      });
      return { ok: res.ok };
    } catch (e) {
      log.warn('ban-account failed', { err: (e as Error).message });
      return { ok: false };
    }
  }

  async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/unban`, {
        method: 'POST',
        headers: internalHeaders('admin', this.internalKey),
      });
      return { ok: res.ok };
    } catch (e) {
      log.warn('unban-account failed', { err: (e as Error).message });
      return { ok: false };
    }
  }
}

// ── analyticsvc query (/internal/query, A9-6) ────────────────
export interface AnalyticsEventCountRow { date: string; event: string; count: number }
export interface AnalyticsDauRow { date: string; dau: number }
export interface AnalyticsFunnelRow { date: string; platform: string; funnel_step: string; count: number; conversion_rate?: number }

export interface AnalyticsRegionRow { locale: string; devices: number }
export interface AnalyticsOsRow { os: string; devices: number }
export interface AnalyticsLoginHourRow { hour: number; count: number }
export interface AnalyticsRetentionRow {
  date: string;
  cohort_size: number;
  d1?: number;
  d7?: number;
  d1_rate?: number;
  d7_rate?: number;
}

export interface AnalyticsQueryResult {
  event_counts?: AnalyticsEventCountRow[];
  dau?: AnalyticsDauRow[];
  funnel?: AnalyticsFunnelRow[];
  region_dist?: AnalyticsRegionRow[];
  os_dist?: AnalyticsOsRow[];
  login_hour?: AnalyticsLoginHourRow[];
  retention?: AnalyticsRetentionRow[];
}

export interface AnalyticsClient {
  readonly available: boolean;
  query(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult>;
}

export class HttpAnalyticsClient implements AnalyticsClient {
  constructor(
    private readonly analyticsUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.analyticsUrl !== null; }

  async query(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult> {
    if (!this.analyticsUrl) return {};
    try {
      const qs = new URLSearchParams({ type, days: String(days) });
      if (platform) qs.set('platform', platform);
      const res = await fetch(`${this.analyticsUrl}/internal/query?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('analytics query non-2xx', { type, status: res.status });
        return {};
      }
      type Payload = {
        type: string;
        counts?: AnalyticsEventCountRow[];
        dau?: AnalyticsDauRow[];
        funnel?: AnalyticsFunnelRow[];
        regions?: AnalyticsRegionRow[];
        os_dist?: AnalyticsOsRow[];
        login_hour?: AnalyticsLoginHourRow[];
        retention?: AnalyticsRetentionRow[];
      };
      const body = (await res.json()) as { data: Payload };
      const p = body.data;
      if (!p) return {};
      if (p.type === 'event_counts') return { event_counts: p.counts ?? [] };
      if (p.type === 'dau') return { dau: p.dau ?? [] };
      if (p.type === 'funnel') return { funnel: p.funnel ?? [] };
      if (p.type === 'region_dist') return { region_dist: p.regions ?? [] };
      if (p.type === 'os_dist') return { os_dist: p.os_dist ?? [] };
      if (p.type === 'login_hour') return { login_hour: p.login_hour ?? [] };
      if (p.type === 'retention') return { retention: p.retention ?? [] };
      return {};
    } catch (e) {
      log.warn('analytics query failed', { type, err: (e as Error).message });
      return {};
    }
  }
}

// ── Mail delivery (meta system mail endpoint, OPS_DESIGN §4.1 / §3.3) ─────
// Compensation execution = create a system mail (wallet is never touched). Endpoint implemented per SOCIAL_DESIGN S6-3, mail backend built in parallel;
// admin wires the contract shape first. When available=false (not configured) or the endpoint is absent (404/501), execution fails → ticket
// marked as failed and retryable, to be re-run after the mail backend is ready for integration.
export interface MailSendReq {
  /** Idempotency key (ticket dispatchKey) — prevents duplicate execution. */
  dispatchKey: string;
  scope: 'single' | 'global';
  target: CompTarget;
  subject: string;
  body: string;
  attachments: CompAttachment[];
  expireDays: number;
}
export interface MailSendRes {
  ok: boolean;
  recipientCount?: number;
  error?: string;
}
export interface MailPreviewReq {
  scope: 'single' | 'global';
  target: CompTarget;
}
export interface MailPreviewRes {
  ok: boolean;
  recipientCount: number;
  error?: string;
}

export interface MailDispatcher {
  readonly available: boolean;
  send(req: MailSendReq): Promise<MailSendRes>;
  preview(req: MailPreviewReq): Promise<MailPreviewRes>;
}

export class HttpMailDispatcher implements MailDispatcher {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async send(req: MailSendReq): Promise<MailSendRes> {
    if (!this.metaBaseUrl) return { ok: false, error: 'mail backend unavailable' };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mail/system/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
        body: JSON.stringify(req),
      });
      if (res.status === 404 || res.status === 501) {
        return { ok: false, error: 'mail endpoint not yet available (S6-3)' };
      }
      if (!res.ok) return { ok: false, error: `mail send failed: HTTP ${res.status}` };
      return (await res.json()) as MailSendRes;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async preview(req: MailPreviewReq): Promise<MailPreviewRes> {
    if (!this.metaBaseUrl) return { ok: false, recipientCount: 0, error: 'mail backend unavailable' };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/mail/system/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
        body: JSON.stringify(req),
      });
      if (res.status === 404 || res.status === 501) {
        return { ok: false, recipientCount: 0, error: 'mail endpoint not yet available (S6-3)' };
      }
      if (!res.ok) return { ok: false, recipientCount: 0, error: `preview failed: HTTP ${res.status}` };
      return (await res.json()) as MailPreviewRes;
    } catch (e) {
      return { ok: false, recipientCount: 0, error: (e as Error).message };
    }
  }
}

// ── SLG season operations (worldsvc /admin/world/*, G7/§17.7) ────────
/** Operational summary for one world region (used in list views). */
export interface SlgWorldSummary {
  worldId: string;
  season: number;
  shard: number;
  status: string;
  population: number;
  capacity: number;
  openAt: number;
  resetAt?: number;
  engineVersion?: number;
}

export interface WorldClient {
  readonly available: boolean;
  listWorlds(): Promise<SlgWorldSummary[]>;
  openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void>;
  settleWorld(worldId: string): Promise<unknown>;
  resetWorld(worldId: string): Promise<unknown>;
  closeWorld(worldId: string): Promise<void>;
  /** Scan for anomalous auction transactions (G7 anti-RMT). worldsvc aggregates suspicious pairs offline; admin creates an audit ticket based on the results. */
  listAuctionAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]>;

  // ── Map templates (§24 Layer A, admin map editor) ──
  listMapTemplates(): Promise<MapTemplateSummary[]>;
  generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary>;
  getMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]>;
  saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }>;
  activateMapTemplate(templateId: string): Promise<void>;
  deleteMapTemplate(templateId: string): Promise<void>;
}

/** admin → worldsvc internal HTTP (X-Internal-Key). worldsvc endpoints are in the internal branch of httpApi.ts. */
export class HttpWorldClient implements WorldClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async listWorlds(): Promise<SlgWorldSummary[]> {
    if (!this.baseUrl) return [];
    const res = await fetch(`${this.baseUrl}/admin/world/list`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`listWorlds failed: HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; data?: SlgWorldSummary[] };
    return body.data ?? [];
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
  }

  async openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.post('/admin/world/open', { worldId, season, shard, capacity });
  }
  async settleWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/settle', { worldId });
  }
  async resetWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/reset', { worldId });
  }
  async closeWorld(worldId: string): Promise<void> {
    await this.post('/admin/world/close', { worldId });
  }

  async listAuctionAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]> {
    if (!this.baseUrl) return [];
    const qs = new URLSearchParams({ worldId });
    if (windowSec != null) qs.set('windowSec', String(windowSec));
    const res = await fetch(`${this.baseUrl}/admin/world/audit/anomalies?${qs}`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`listAuctionAnomalies failed: HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; data?: AuctionAnomaly[] };
    return body.data ?? [];
  }

  private async get(path: string): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, { headers: internalHeaders('admin', this.internalKey) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
  }

  private async putOrDelete(method: 'PUT' | 'DELETE', path: string, payload?: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
  }

  // ── Map templates (§24 Layer A, admin map editor) ──
  async listMapTemplates(): Promise<MapTemplateSummary[]> {
    if (!this.baseUrl) return [];
    return (await this.get('/admin/world/map-templates')) as MapTemplateSummary[];
  }
  async generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    return (await this.post('/admin/world/map-templates/generate', { templateId, width, height })) as MapTemplateSummary;
  }
  async getMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]> {
    if (!this.baseUrl) return [];
    const qs = new URLSearchParams({ x: String(x), y: String(y), w: String(w), h: String(h) });
    return (await this.get(`/admin/world/map-templates/${encodeURIComponent(templateId)}/tiles?${qs}`)) as MapTemplateTile[];
  }
  async saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
    return (await this.putOrDelete('PUT', `/admin/world/map-templates/${encodeURIComponent(templateId)}/tiles`, { tiles })) as { updated: number };
  }
  async activateMapTemplate(templateId: string): Promise<void> {
    await this.post(`/admin/world/map-templates/${encodeURIComponent(templateId)}/activate`, {});
  }
  async deleteMapTemplate(templateId: string): Promise<void> {
    await this.putOrDelete('DELETE', `/admin/world/map-templates/${encodeURIComponent(templateId)}`);
  }
}

export const nullWorldClient: WorldClient = {
  available: false,
  async listWorlds() { return []; },
  async openWorld() { throw new Error('worldsvc not configured'); },
  async settleWorld() { throw new Error('worldsvc not configured'); },
  async resetWorld() { throw new Error('worldsvc not configured'); },
  async closeWorld() { throw new Error('worldsvc not configured'); },
  async listAuctionAnomalies() { return []; },
  async listMapTemplates() { return []; },
  async generateMapTemplate() { throw new Error('worldsvc not configured'); },
  async getMapTemplateTiles() { return []; },
  async saveMapTemplateTiles() { throw new Error('worldsvc not configured'); },
  async activateMapTemplate() { throw new Error('worldsvc not configured'); },
  async deleteMapTemplate() { throw new Error('worldsvc not configured'); },
};

// ── Ladder season (meta /admin/ladder/season/roll, SE-3) ─────────────────────
export interface LadderSeasonInfo {
  seasonNo: number;
  startAt: number;
  endAt: number;
  state: string;
}

export interface LadderClient {
  readonly available: boolean;
  /** CAS-idempotent ladder season advance; returns the new (or current) season info. */
  rollSeason(): Promise<LadderSeasonInfo>;
  /** Read the current season (GET /internal/ladder/season/current). */
  getCurrentSeason(): Promise<LadderSeasonInfo | null>;
}

export class HttpLadderClient implements LadderClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async rollSeason(): Promise<LadderSeasonInfo> {
    if (!this.metaBaseUrl) throw new Error('meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/ladder/season/roll`, {
      method: 'POST',
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`rollSeason HTTP ${res.status}`);
    const body = (await res.json()) as { season: LadderSeasonInfo };
    return body.season;
  }

  async getCurrentSeason(): Promise<LadderSeasonInfo | null> {
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/ladder/season/current`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { season?: LadderSeasonInfo };
      return body.season ?? null;
    } catch {
      return null;
    }
  }
}

export const nullLadderClient: LadderClient = {
  available: false,
  async rollSeason() { throw new Error('meta not configured'); },
  async getCurrentSeason() { return null; },
};

// ── Limited-time event management (meta /admin/events, B6 events.manage) ────────
export interface EventsClient {
  readonly available: boolean;
  list(): Promise<EventDoc[]>;
  create(input: EventInput): Promise<EventDoc>;
  update(eventId: string, input: EventInput): Promise<EventDoc>;
  remove(eventId: string): Promise<void>;
}

/** Business error returned by meta (detail lets operators see the validation reason); admin httpApi responds with 4xx accordingly. */
export class EventsClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EventsClientError';
  }
}

export class HttpEventsClient implements EventsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<EventDoc[]> {
    if (!this.metaBaseUrl) return [];
    const res = await fetch(`${this.metaBaseUrl}/admin/events`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list events HTTP ${res.status}`);
    const body = (await res.json()) as { events?: EventDoc[] };
    return body.events ?? [];
  }

  async create(input: EventInput): Promise<EventDoc> {
    return this.write('POST', '/admin/events', input);
  }
  async update(eventId: string, input: EventInput): Promise<EventDoc> {
    return this.write('PATCH', `/admin/events/${encodeURIComponent(eventId)}`, input);
  }
  async remove(eventId: string): Promise<void> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
      throw new EventsClientError(res.status, body.detail ?? body.error ?? `delete event HTTP ${res.status}`);
    }
  }

  private async write(method: string, path: string, input: EventInput): Promise<EventDoc> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as { event?: EventDoc; detail?: string; error?: string };
    if (!res.ok || !body.event) {
      throw new EventsClientError(res.status, body.detail ?? body.error ?? `${path} HTTP ${res.status}`);
    }
    return body.event;
  }
}

export const nullEventsClient: EventsClient = {
  available: false,
  async list() { return []; },
  async create() { throw new EventsClientError(503, 'meta not configured'); },
  async update() { throw new EventsClientError(503, 'meta not configured'); },
  async remove() { throw new EventsClientError(503, 'meta not configured'); },
};

// ── Custom gacha pool management (meta /admin/gacha/*, GACHA_DESIGN §12, gacha.pools.manage) ────────
/** A pool config as listed by meta/commercial (derived §2.2 or custom §12; discriminated by `kind`). */
export interface AdminGachaPool {
  id: string;
  name: string;
  startAt: number;
  endAt: number;
  kind?: 'derived' | 'custom';
  // derived pools
  featuredLegendary?: string;
  // custom pools (§12)
  costSingle?: number;
  costTen?: number;
  categories?: CustomPoolConfig['categories'];
  createdBy: string;
  createdAt: number;
  closedAt?: number;
}

export interface GachaPoolsClient {
  readonly available: boolean;
  list(): Promise<AdminGachaPool[]>;
  catalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>>;
  createCustom(config: CustomPoolConfig, createdBy: string): Promise<{ id: string }>;
  close(id: string): Promise<{ id: string }>;
}

export class HttpGachaPoolsClient implements GachaPoolsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<AdminGachaPool[]> {
    if (!this.metaBaseUrl) return [];
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list gacha pools HTTP ${res.status}`);
    const body = (await res.json()) as { pools?: AdminGachaPool[] };
    return body.pools ?? [];
  }

  async catalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/catalog`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    const body = (await res.json().catch(() => ({}))) as { catalog?: Record<GachaCategory, GachaCatalogItem[]>; error?: string };
    if (!res.ok || !body.catalog) throw new EventsClientError(res.status, body.error ?? `catalog HTTP ${res.status}`);
    return body.catalog;
  }

  async createCustom(config: CustomPoolConfig, createdBy: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools/custom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify({ ...config, createdBy }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; detail?: string; error?: string };
    if (!res.ok || !body.id) throw new EventsClientError(res.status, body.detail ?? body.error ?? `create pool HTTP ${res.status}`);
    return { id: body.id };
  }

  async close(id: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new EventsClientError(res.status, body.error ?? `close pool HTTP ${res.status}`);
    return { id: body.id };
  }
}

export const nullGachaPoolsClient: GachaPoolsClient = {
  available: false,
  async list() { return []; },
  async catalog() { throw new EventsClientError(503, 'meta not configured'); },
  async createCustom() { throw new EventsClientError(503, 'meta not configured'); },
  async close() { throw new EventsClientError(503, 'meta not configured'); },
};

// ── Promo code client (B-PROMO) ────────────────────────────

export interface PromoCodeView {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  redeemed: number;
  note?: string;
  createdBy: string;
  createdAt: number;
}

export interface PromoClient {
  readonly available: boolean;
  list(): Promise<PromoCodeView[]>;
  create(args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string; createdBy: string }): Promise<{ code: string }>;
}

export class HttpPromoClient implements PromoClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<PromoCodeView[]> {
    if (!this.metaBaseUrl) return [];
    const res = await fetch(`${this.metaBaseUrl}/admin/promo/codes`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list promo codes HTTP ${res.status}`);
    const body = (await res.json()) as { codes?: PromoCodeView[] };
    return body.codes ?? [];
  }

  async create(args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string; createdBy: string }): Promise<{ code: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/promo/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!res.ok || !body.code) {
      throw new EventsClientError(res.status, body.error ?? `create promo code HTTP ${res.status}`);
    }
    return { code: body.code };
  }
}

export const nullPromoClient: PromoClient = {
  available: false,
  async list() { return []; },
  async create() { throw new EventsClientError(503, 'meta not configured'); },
};
