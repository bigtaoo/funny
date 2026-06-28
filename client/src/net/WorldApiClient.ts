// WorldApiClient — SLG REST client for worldsvc (S8).
// Separate from ApiClient because worldsvc runs on a different base URL
// (getWorldBaseUrl()) and is NOT included in openapi.yml (metaserver contract).
//
// Auth: reads the JWT stored by SaveManager under key nw_token.
// All responses are wrapped in { ok: true, data: T } | { ok: false, code, message }.
//
// DTO types are generated from server/contracts/openapi-world.yml via npm run rest:gen
// → src/net/openapi-world.ts. Do NOT hand-edit these type aliases.

import { getWorldBaseUrl } from './config';
import type { IStorage } from '../platform/IPlatform';
import type { components } from './openapi-world';

// ── Generated DTO type aliases (single source of truth = openapi-world.yml) ──

export type WorldTileView = components['schemas']['WorldTileView'];
export type WorldMapView = components['schemas']['WorldMapView'];

/** 稀疏占领格（zoom 2/3 鸟瞰层，只含被占领格）。 */
export interface WorldTileSparseView {
  x: number;
  y: number;
  type: string;
  mine?: boolean;
  ally?: boolean;
  allySect?: boolean;
}

export interface WorldMapSparseView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  lod: 'thin' | 'mid';
  tiles: WorldTileSparseView[];
}
export type PlayerWorldView = components['schemas']['PlayerWorldView'];
export type MarchView = components['schemas']['MarchView'];
export type FamilyMemberView = components['schemas']['FamilyMemberView'];
export type FamilyView = components['schemas']['FamilyView'];
export type FamilyMessageView = components['schemas']['FamilyMessageView'];
export type AuctionView = components['schemas']['AuctionView'];
export type NationView = components['schemas']['NationView'];
export type SeasonView = components['schemas']['SeasonView'];
export type SlgShopItemView = components['schemas']['SlgShopItemView'];
export type SiegeReplayView = components['schemas']['SiegeReplayView'];
export type DefenseConfig = components['schemas']['DefenseConfig'];
export type TeamTemplate = components['schemas']['TeamTemplate'];
export type ArmyEntry = components['schemas']['ArmyEntry'];
export type SectView = components['schemas']['SectView'];
export type SectDetailView = components['schemas']['SectDetailView'];
export type SectMemberFamilyView = components['schemas']['SectMemberFamilyView'];
export type SectMessageView = components['schemas']['SectMessageView'];
export type SectVoteResult = components['schemas']['SectVoteResult'];

export interface WorldChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
}

// Derived enum types for method parameters
type MarchKind = Exclude<MarchView['kind'], 'return'>;
type FamilyRole = FamilyMemberView['role'];

const TOKEN_KEY = 'nw_token';

// ── Error ────────────────────────────────────────────────────────────────────

export class WorldApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorldApiError';
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class WorldApiClient {
  constructor(private readonly storage: IStorage) {}

  get available(): boolean {
    // '' (Docker/prod same-origin proxy) and 'http://...' (dev explicit URL) are both valid
    // — worldsvc is reachable in any standard build. The old `!== ''` guard was wrong.
    return true;
  }

  /**
   * Ping worldsvc /health. Returns false ONLY on a definitive non-200 response
   * from a reachable server (e.g. 503 = up-but-unhealthy).
   *
   * A thrown fetch (timeout / CORS rejection / connection refused) is treated as
   * INCONCLUSIVE → returns true (no offline badge). Rationale: in dev the /health
   * route often lacks the CORS headers the real /world|/family|/auction routes
   * carry, so the probe gets rejected even though the actual feature is fully
   * reachable — that false negative wrongly greyed the 大世界 entry. Better to let
   * the user click through and hit real error handling than to mislabel a working
   * service as offline.
   */
  async checkHealth(): Promise<boolean> {
    const base = getWorldBaseUrl();
    // Empty base = same-origin nginx proxy (Docker/production). worldsvc is guaranteed
    // up by the Docker healthcheck; no external ping needed or possible (nginx only
    // routes /world* /family* /auction*, not /health). Return true immediately.
    if (!base) return true;
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(id);
      return res.ok;
    } catch {
      // Inconclusive — do not claim offline (see method doc).
      return true;
    }
  }

  private token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    const base = getWorldBaseUrl();
    const url = base + path;
    const token = this.token();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // AbortError → convert to TypeError so callers see a consistent network failure.
      throw new TypeError(`world api ${method} ${path} failed: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }

    const json = await res.json() as { ok: boolean; data?: T; code?: string; message?: string };
    if (!json.ok) {
      throw new WorldApiError(json.code ?? 'UNKNOWN', json.message ?? 'world api error');
    }
    return json.data as T;
  }

  // ── World ──────────────────────────────────────────────────────────────────

  async getMe(worldId: string): Promise<PlayerWorldView> {
    return this.req('GET', `/world/me?worldId=${encodeURIComponent(worldId)}`);
  }

  async getMap(worldId: string, cx: number, cy: number, r: number): Promise<WorldMapView> {
    return this.req('GET', `/world/map?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`);
  }

  /** 稀疏占领层（zoom 2/3）：只返回被占领格，无 profile RPC，无视野计算。 */
  async getMapSparse(worldId: string, cx: number, cy: number, r: number, lod: 'thin' | 'mid'): Promise<WorldMapSparseView> {
    return this.req('GET', `/world/map/sparse?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}&lod=${lod}`);
  }

  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('GET', `/world/tile/${x}:${y}:${encodeURIComponent(worldId)}`);
  }

  async getMarches(worldId: string): Promise<MarchView[]> {
    return this.req('GET', `/world/march?worldId=${encodeURIComponent(worldId)}`);
  }

  /** 进入世界：系统自动落城（§3.4，优先靠近家族→外环新手区），落点由服务端决定，玩家不传坐标。 */
  async joinWorld(worldId: string): Promise<PlayerWorldView> {
    return this.req('POST', '/world/join', { worldId });
  }

  /**
   * 按赛季解析本账号应进的 shard（G6/§20）：只解析不落城，进图前拿真实 worldId（粘性>家族>单随，溢出开新区）。
   */
  async resolveSeason(season: number): Promise<{ worldId: string }> {
    return this.req('POST', '/world/season/resolve', { season });
  }

  /**
   * 按赛季 join（G6/§20）：服务端解析本账号应进的 shard（宗门>家族>单随，溢出开新区）后**系统自动落城**（§3.4）。
   * 返回的 PlayerWorldView 含解析出的 `worldId`，客户端据此进图。玩家不传坐标。
   */
  async joinSeason(season: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/season/join', { season });
  }

  async occupyTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/occupy', { worldId, x, y });
  }

  async abandonTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/abandon', { worldId, x, y });
  }

  /** 主动迁城（花 RELOCATE_COST 金币迁主城到 (x,y)）。返回迁城后的玩家世界态。 */
  async relocateBase(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/relocate', { worldId, x, y });
  }

  /** 建瞭望塔（在己方领地 (x,y) 花 WATCHTOWER_COST 资源建大半径持久视野源；§18 G5 V2）。返回建塔后该格视图。 */
  async buildWatchtower(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('POST', '/world/watchtower', { worldId, x, y });
  }

  async startMarch(
    worldId: string,
    fromX: number, fromY: number,
    toX: number, toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
  ): Promise<MarchView> {
    return this.req('POST', '/world/march', {
      worldId, fromX, fromY, toX, toY, kind, troops,
      ...(teamId ? { teamId } : {}),
    });
  }

  async recallMarch(marchId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/world/march/${encodeURIComponent(marchId)}/recall`, { worldId });
  }

  // ── Troops（训练队列 S8-2）──────────────────────────────────────────────────

  /** 入队训练（消耗粮食 + 时间）。返回更新后的玩家状态。 */
  async trainTroops(worldId: string, qty: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/troops/train', { worldId, qty });
  }

  /** 金币加速训练（走 commercial 扣币）。 */
  async speedupTraining(worldId: string, coins: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/troops/speedup', { worldId, coins });
  }

  // ── Defense（防守 config 内嵌，S8-4）────────────────────────────────────────

  /** 读当前防守 config（C3 编辑器预填）。tileKey='base' 主城 或 '{x}:{y}' 领地；未设置返回 null。 */
  async getDefense(worldId: string, tileKey: string): Promise<DefenseConfig | null> {
    return this.req('GET', `/world/defense?worldId=${encodeURIComponent(worldId)}&tileKey=${encodeURIComponent(tileKey)}`);
  }

  /** 设/改防守 config。tileKey='base' 主城 或 '{x}:{y}' 领地。 */
  async setDefense(worldId: string, tileKey: string, defenseConfig: DefenseConfig): Promise<{ ok: true }> {
    return this.req('PUT', '/world/defense', { worldId, tileKey, defenseConfig });
  }

  // ── Teams（进攻布阵模板，G3-2c）─────────────────────────────────────────────

  /** 读进攻布阵模板列表（队伍编辑器 / 出征选队预填）。 */
  async getTeams(worldId: string): Promise<TeamTemplate[]> {
    return this.req('GET', `/world/teams?worldId=${encodeURIComponent(worldId)}`);
  }

  /** 覆盖写进攻布阵模板（整组传全量，≤5 支）。 */
  async setTeams(worldId: string, teams: TeamTemplate[]): Promise<{ ok: true }> {
    return this.req('PUT', '/world/teams', { worldId, teams });
  }

  // ── Siege replay（重播观战，G3-2c）──────────────────────────────────────────

  /**
   * 取一场关键围攻的重播关卡（seed + 双方布阵重建的 LevelDefinition）。攻守双方可读。
   * 客户端凭返回的 seed 以空 ReplayInputSource 在 siege 模式 headless 重跑 → 逐字复现。
   */
  async getSiegeReplay(worldId: string, siegeId: string): Promise<SiegeReplayView> {
    return this.req('GET', `/world/siege/${encodeURIComponent(siegeId)}/replay?worldId=${encodeURIComponent(worldId)}`);
  }

  // ── Nations（国家系统 S8-6.5）───────────────────────────────────────────────

  async getNations(worldId: string): Promise<NationView[]> {
    return this.req('GET', `/world/nations?worldId=${encodeURIComponent(worldId)}`);
  }

  async setNationName(worldId: string, capitalIdx: number, name: string): Promise<{ ok: true }> {
    return this.req('POST', `/world/nations/${capitalIdx}/name`, { worldId, name });
  }

  // ── Season（赛季 S8-7）──────────────────────────────────────────────────────

  async getSeason(worldId: string): Promise<SeasonView> {
    return this.req('GET', `/world/season?worldId=${encodeURIComponent(worldId)}`);
  }

  // ── SLG Shop（变现 S8-8）────────────────────────────────────────────────────

  async getShopItems(): Promise<SlgShopItemView[]> {
    return this.req('GET', '/world/shop/items');
  }

  async buyShopItem(worldId: string, itemId: string): Promise<{ ok: true }> {
    return this.req('POST', '/world/shop/buy', { worldId, itemId });
  }

  // ── Family ─────────────────────────────────────────────────────────────────

  async listFamilies(worldId: string): Promise<FamilyView[]> {
    return this.req('GET', `/family/list?worldId=${encodeURIComponent(worldId)}`);
  }

  async getFamily(familyId: string): Promise<FamilyView> {
    return this.req('GET', `/family/${encodeURIComponent(familyId)}`);
  }

  async createFamily(worldId: string, name: string, tag: string): Promise<FamilyView> {
    return this.req('POST', '/family/create', { worldId, name, tag });
  }

  async joinFamily(worldId: string, familyId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/join', { worldId, familyId });
  }

  async leaveFamily(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/leave', { worldId });
  }

  async kickMember(worldId: string, targetId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/kick', { worldId, targetId });
  }

  async setRole(worldId: string, targetId: string, role: FamilyRole): Promise<{ ok: true }> {
    return this.req('POST', '/family/role', { worldId, targetId, role });
  }

  async dissolveFamily(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/dissolve', { worldId });
  }

  async sendFamilyMessage(worldId: string, body: string, senderName?: string): Promise<{ id: string }> {
    return this.req('POST', '/family/message', { worldId, body, ...(senderName ? { senderName } : {}) });
  }

  async getFamilyChannel(
    worldId: string,
    familyId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<FamilyMessageView[]> {
    const params = new URLSearchParams({ worldId, familyId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/family/channel?${params}`);
  }

  // ── Auction ────────────────────────────────────────────────────────────────

  async listAuctions(
    worldId: string,
    opts?: { itemType?: string; limit?: number },
  ): Promise<AuctionView[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.itemType) params.set('itemType', opts.itemType);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/auction/list?${params}`);
  }

  async getMyListings(worldId: string): Promise<AuctionView[]> {
    return this.req('GET', `/auction/mine?worldId=${encodeURIComponent(worldId)}`);
  }

  /**
   * 挂拍。fixed 模式传 price（一口价单价）；auction 模式传 saleMode='auction' + startPrice（起拍单价）
   * + 可选 buyoutPrice（一口价保底单价）。
   */
  async createAuction(
    worldId: string,
    itemType: 'material' | 'equipment',
    item: Record<string, unknown>,
    qty: number,
    durationSec: number,
    opts?: {
      saleMode?: 'fixed' | 'auction';
      price?: number;
      startPrice?: number;
      buyoutPrice?: number;
      designatedBuyerId?: string;
    },
  ): Promise<AuctionView> {
    return this.req('POST', '/auction/create', {
      worldId, itemType, item, qty, durationSec,
      saleMode: opts?.saleMode ?? 'fixed',
      ...(opts?.price != null ? { price: opts.price } : {}),
      ...(opts?.startPrice != null ? { startPrice: opts.startPrice } : {}),
      ...(opts?.buyoutPrice != null ? { buyoutPrice: opts.buyoutPrice } : {}),
      ...(opts?.designatedBuyerId ? { designatedBuyerId: opts.designatedBuyerId } : {}),
    });
  }

  async buyAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/buy`, { worldId });
  }

  /** 竞拍出价（saleMode='auction'）。amount = 出价单价；达/超 buyoutPrice 立即结拍。 */
  async placeBid(auctionId: string, worldId: string, amount: number): Promise<AuctionView> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/bid`, { worldId, amount });
  }

  async cancelAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/cancel`, { worldId });
  }

  // ── Sect（宗门 S8-4b）────────────────────────────────────────────────────────

  async listSects(worldId: string): Promise<SectView[]> {
    return this.req('GET', `/sect/list?worldId=${encodeURIComponent(worldId)}`);
  }

  async getSect(sectId: string): Promise<SectDetailView> {
    return this.req('GET', `/sect/${encodeURIComponent(sectId)}`);
  }

  async createSect(worldId: string, name: string, tag: string): Promise<SectDetailView> {
    return this.req('POST', '/sect/create', { worldId, name, tag });
  }

  async joinSect(worldId: string, sectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/join', { worldId, sectId });
  }

  async leaveSect(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/leave', { worldId });
  }

  async dissolveSect(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/dissolve', { worldId });
  }

  async allySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/ally', { worldId, targetSectId });
  }

  async unallySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/unally', { worldId, targetSectId });
  }

  async voteRemoveSectLeader(worldId: string, nomineeFamilyId: string): Promise<SectVoteResult> {
    return this.req('POST', '/sect/vote-remove-leader', { worldId, nomineeFamilyId });
  }

  async sendSectMessage(worldId: string, body: string, senderName?: string): Promise<SectMessageView> {
    return this.req('POST', '/sect/message', { worldId, body, ...(senderName ? { senderName } : {}) });
  }

  async getSectChannel(
    worldId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<SectMessageView[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/sect/channel?${params}`);
  }

  // ── 世界频道（国家/公频，S6-4，一次 50 金币）──────────────────────────────

  async getWorldChannel(
    worldId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<WorldChatMessage[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/nation/channel?${params}`);
  }

  async sendWorldChannelMessage(
    worldId: string,
    body: string,
    senderName: string,
  ): Promise<WorldChatMessage> {
    return this.req('POST', '/nation/message', { worldId, body, senderName });
  }
}
