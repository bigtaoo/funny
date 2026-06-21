// admin → 业务服务的内部调用（OPS_DESIGN §4.1）。admin 持 X-Internal-Key 作内部特权调用方。
// 与 commercialClient / gatewayClient 同形：HTTP 实现 + 接口（便于测试注入假实现）。
import {
  createLogger,
  internalHeaders,
  type CompAttachment,
  type CompTarget,
  type LiveStats,
} from '@nw/shared';

const log = createLogger('admin:clients');

// ── stats（gateway / matchsvc）────────────────────────────
export interface StatsClient {
  readonly available: boolean;
  /** 拉一次聚合实时态；不可用 / 出错返回零值（采样不阻断）。 */
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

/** 合并 gateway + matchsvc 的 GET /internal/stats。任一不可用其字段记 0。 */
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

// ── 玩家查询（meta，player.lookup）────────────────────────
export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
}

export interface PlayerClient {
  readonly available: boolean;
  /** 按 9 位公开 id 查玩家档案；未找到返回 null。 */
  lookupByPublicId(publicId: string): Promise<PlayerProfile | null>;
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
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(
        `${this.metaBaseUrl}/internal/player?publicId=${encodeURIComponent(publicId)}`,
        { headers: internalHeaders('admin', this.internalKey) },
      );
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
}

// ── analyticsvc 查询（/internal/query，A9-6）──────────────────
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

// ── 邮件投递（meta 系统邮件端点，OPS_DESIGN §4.1 / §3.3）─────
// 补偿执行 = 创建系统邮件（不碰钱包）。端点由 SOCIAL_DESIGN S6-3 落地，邮件后端并行做，
// admin 先按契约形状对接。available=false（未配置）或端点不存在（404/501）时执行失败 → 工单
// 标 failed 可重试，等邮件后端就绪后联调。
export interface MailSendReq {
  /** 幂等键（工单 dispatchKey）——防重复执行。 */
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

// ── SLG 赛季运维（worldsvc /admin/world/*，G7/§17.7）────────
/** 一个大区的运维概要（列表用）。 */
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
}

/** admin → worldsvc 内部 HTTP（X-Internal-Key）。worldsvc 端点见 httpApi.ts 内部分支。 */
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
}

export const nullWorldClient: WorldClient = {
  available: false,
  async listWorlds() { return []; },
  async openWorld() { throw new Error('worldsvc not configured'); },
  async settleWorld() { throw new Error('worldsvc not configured'); },
  async resetWorld() { throw new Error('worldsvc not configured'); },
  async closeWorld() { throw new Error('worldsvc not configured'); },
};
