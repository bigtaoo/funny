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
    return getWorldBaseUrl() !== '' || this.storage.getItem('nw_world_base') !== null;
  }

  private token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const base = getWorldBaseUrl();
    const url = base + path;
    const token = this.token();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

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

  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('GET', `/world/tile/${x}:${y}:${encodeURIComponent(worldId)}`);
  }

  async getMarches(worldId: string): Promise<MarchView[]> {
    return this.req('GET', `/world/march?worldId=${encodeURIComponent(worldId)}`);
  }

  async joinWorld(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/join', { worldId, x, y });
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

  async createAuction(
    worldId: string,
    itemType: 'material' | 'equipment',
    item: Record<string, unknown>,
    qty: number,
    price: number,
    durationSec: number,
    designatedBuyerId?: string,
  ): Promise<AuctionView> {
    return this.req('POST', '/auction/create', {
      worldId, itemType, item, qty, price, durationSec,
      ...(designatedBuyerId ? { designatedBuyerId } : {}),
    });
  }

  async buyAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/buy`, { worldId });
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
}
