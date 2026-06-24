// metaserver REST 客户端（S0-5）。覆盖 S0 用到的端点：auth/device · auth/wx · GET/PUT save。
// 契约 = contracts/openapi.yml（统一响应包络 ApiResp<T>，乐观锁 If-Match）。
// 经济/盲盒（S2）随 EconomyClient 再加；此处只做云存档需要的部分。
//
// 传输用全局 fetch（Web / CrazyGames 原生支持）。微信小游戏无 fetch（用 wx.request）——
// 其云同步随微信联机合规一并排期；当前 SaveManager 在无 baseUrl / fetch 时退化为纯本地（离线优先）。

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch, EquipmentInstance, EquipSlot } from '../game/meta/SaveData';
import type { components, operations } from './openapi';
import { netLog } from './log';
import { packReplayBlob, unpackReplayBlob } from './replayCompress';

const log = netLog('api');

// ── Wire DTOs：从 openapi.yml codegen（contracts 单一来源，`npm run rest:gen`）取，
//    契约漂移在 tsc 时暴露。SaveData/SyncPatch/Rarity 仍用客户端自有 meta 镜像（域类型，
//    刻意手维护）；纯线协议 DTO（shop/gacha/auth/history）这里 alias 生成 schema。
type Schemas = components['schemas'];

export type ShopItem = Schemas['ShopItem'];
export type GachaPool = Schemas['GachaPool'];
export type GachaEntry = GachaPool['entries'][number];
export type GachaResultEntry = Schemas['GachaResult'];
/** 对战历史一条（从当前账号视角）。 */
export type MatchHistoryEntry = Schemas['MatchHistoryEntry'];
export type AuthResult = Schemas['AuthResult'];
// —— 社交（S6-1 好友 / S6-2 私聊 / S6-3 邮件）——
export type ProfileView = Schemas['ProfileView'];
export type FriendView = Schemas['FriendView'];
export type FriendRequestView = Schemas['FriendRequestView'];
export type ConversationView = Schemas['ConversationView'];
export type ChatMessageView = Schemas['ChatMessageView'];
export type MailView = Schemas['MailView'];
export type MailAttachmentView = Schemas['MailAttachmentView'];
/** 离线红点聚合（申请 / 未读会话 / 未读邮件 + total），登录后拉一次。 */
export type SocialBadges = Schemas['SocialBadges'];
/** 服务端持久化录像（opaque 帧，base64）；客户端用 net/serverReplay 解码回放。 */
export type ServerReplay = Schemas['MatchReplay'];
// —— 成就系统（S9-5）——
/** 成就定义（硬编码 @nw/shared，服务端下发；客户端据此 + stats 本地算阶）。 */
export type Achievement = Schemas['Achievement'];
/** GET /achievements 回包：定义表 + 我的 stats + 已领进度。 */
export type AchievementsView =
  operations['getAchievements']['responses']['200']['content']['application/json']['data'];
// —— 限时活动（B6，ADR-014）——
/** GET /events 回包一条活动（含任务进度 + 积分商店）。EventScene 的视图类型与此结构兼容。 */
export type EventView =
  operations['getEvents']['responses']['200']['content']['application/json']['data']['events'][number];
// —— 留存系统（B5，RETENTION_DESIGN）——
/** GET /retention 回包：签到月历 + 每日任务 + 定义表 + 红点。 */
export interface RetentionView {
  checkin: { monthKey: string; claimedDays: number[] } | null;
  daily: { dayKey: string; completedTasks: Record<string, number>; taskPoints: number; rewardClaimed: boolean } | null;
  defs: {
    rewards: { kind: string; count: number }[];
    tasks: { id: string; points: number }[];
    pointsThreshold: number;
    dailyCoinsReward: number;
  };
  claimable: { checkin: boolean; daily: boolean };
}

type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** PUT /save 结果：成功回推规范化存档，或 409 冲突带当前云端值。 */
export type PushResult =
  | { kind: 'ok'; save: SaveData }
  | { kind: 'conflict'; save: SaveData };

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private token: string | null = null;

  /** @param baseUrl 形如 https://host/api（无尾斜杠）。 */
  constructor(private readonly baseUrl: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  // ── auth（S0-4 / S0-7）──────────────────────────────────
  /** 用平台匿名凭据换 token + accountId；成功后自动持有 token。 */
  async auth(cred: AuthCredential): Promise<AuthResult> {
    const path = cred.kind === 'wx' ? '/auth/wx' : '/auth/device';
    const body = cred.kind === 'wx' ? { code: cred.code } : { deviceId: cred.deviceId };
    const data = await this.post<AuthResult>(path, body);
    this.token = data.token;
    return data;
  }

  // ── 密码账号（SA-1）─────────────────────────────────────
  /** 密码注册（新账号）；成功后自动持有 token。 */
  async register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/register', {
      loginId,
      password,
      ...(displayName ? { displayName } : {}),
    });
    this.token = data.token;
    return data;
  }

  /** 密码登录；成功后自动持有 token。 */
  async login(loginId: string, password: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/login', { loginId, password });
    this.token = data.token;
    return data;
  }

  /** 改密（需已登录，token 已持有）。 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.post<{ ok: true }>('/auth/password/change', { oldPassword, newPassword });
  }

  // ── 账号合规（C5，需登录 token）────────────────────────────────────────────
  /**
   * 软删除账号（C5-b，Apple 5.1.1(v)）：服务端置 `deletedAt`，7 天宽限后异步清数据；
   * 宽限期内重新登录可恢复。返回确认 token（审计用）。调用方清本地 token/存档并回登录页。
   */
  async deleteAccount(): Promise<{ confirmToken: string }> {
    return this.request<{ confirmToken: string }>('DELETE', '/account');
  }

  /** 记录 GDPR 同意（C5-c）：服务端写 `flags.gdprConsent`。匿名/未登录无 token 时不应调用。 */
  async recordGdprConsent(consent: boolean): Promise<void> {
    await this.post<{ ok: true }>('/account/gdpr-consent', { consent });
  }

  // ── save（S0-7）─────────────────────────────────────────
  /** 拉取当前账号云端存档（顺带回带账号展示名 + 公开 id + gateway 地址，供个人资料 / 联机）。 */
  async getSave(): Promise<{ save: SaveData; displayName?: string; publicId?: string; gatewayUrl?: string }> {
    const data = await this.request<{
      save: SaveData;
      displayName?: string;
      publicId?: string;
      gatewayUrl?: string;
    }>('GET', '/save');
    return {
      save: data.save,
      displayName: data.displayName,
      publicId: data.publicId,
      gatewayUrl: data.gatewayUrl,
    };
  }

  /** 改展示名（消耗金币）。回推权威存档 + 新展示名；余额不足 → ApiError('INSUFFICIENT_FUNDS')。 */
  async rename(displayName: string): Promise<{ save: SaveData; displayName: string }> {
    return this.post<{ save: SaveData; displayName: string }>('/profile/rename', { displayName });
  }

  /**
   * 推送客户端同步段，带乐观锁 If-Match: rev。
   * 200 → ok + 规范化存档；409 → conflict + 当前云端值（不抛错，交调用方 pull-merge）。
   */
  async putSave(rev: number, patch: SyncPatch): Promise<PushResult> {
    const res = await this.fetchRaw('PUT', '/save', { save: patch }, { 'If-Match': String(rev) });
    const json = (await res.json()) as ApiResp<{ save: SaveData }> & { save?: SaveData };
    if (res.status === 409) {
      // 409 包络：{ ok:false, error, save: 当前云端值 }
      if (json.save) return { kind: 'conflict', save: json.save };
      throw new ApiError('REV_CONFLICT', 'rev conflict without server save');
    }
    if (!json.ok) {
      throw new ApiError(json.error.code, json.error.message);
    }
    return { kind: 'ok', save: json.data.save };
  }

  // ── PvE 服务器权威（PVE_INTEGRITY_PLAN §8，需登录 token）─────────────
  // progress/stars/materials/pveUpgrades 是服务器权威段；通关/升级走这两个端点，
  // 回推完整权威 SaveData（客户端 adopt 镜像）。仅在线可调。

  /**
   * PvE 通关结算：服务器校验解锁 → 每日上限内发材料+卡牌 → 写 progress/stars → 回推。
   * L1 抽检（§8.6 第 3 步）：被抽中时回 `needsReplay + verifyId`（材料暂扣），调用方补传录像走
   * {@link pveVerify} 复算入账。`unitLevels` 是客户端开局蓝图快照（L0 异常判定，S12）。
   */
  async pveClear(
    levelId: string,
    stars: number,
    unitLevels?: Record<string, number>,
    stats?: Record<string, number>,
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    capped: boolean;
    needsReplay?: boolean;
    verifyId?: string;
    grantedEquipment?: EquipmentInstance;
  }> {
    return this.post<{
      save: SaveData;
      granted: Record<string, number>;
      capped: boolean;
      needsReplay?: boolean;
      verifyId?: string;
      grantedEquipment?: EquipmentInstance;
    }>('/pve/clear', {
      levelId,
      stars,
      ...(unitLevels ? { unitLevels } : {}),
      ...(stats ? { stats } : {}),
    });
  }

  /** 创建录像分享链接（S1-RP）：7 天 TTL，任意人可凭 shareId 取录像（无需登录）。 */
  async createReplayShare(roomId: string): Promise<{ shareId: string }> {
    return this.post<{ shareId: string }>(`/match/${roomId}/replay/share`, {});
  }

  /** 通过分享链接取录像（S1-RP）：无需登录。 */
  async getReplayByShare(shareId: string): Promise<{ replay: unknown }> {
    return this.request<{ replay: unknown }>('GET', `/share/replay/${shareId}`);
  }

  /**
   * 状态流录像游戏外分享 — 铸码（REPLAY_SHARE_DESIGN §3.1）：上传客户端自产的状态流 blob，
   * 返回不可猜 shareCode。需登录。blob 上传前 gzip+base64 压缩（重复 delta JSON 压缩比极高，§7），
   * 服务端 opaque 存储。体量超限 / 限流 → ApiError('BAD_REQUEST' / 'RATE_LIMITED')。
   */
  async createStateReplayShare(blob: unknown): Promise<{ shareCode: string }> {
    const packed = await packReplayBlob(blob);
    return this.post<{ shareCode: string }>('/replay/share', { blob: packed });
  }

  /** 状态流录像公开取（REPLAY_SHARE_DESIGN §3.2）：无需登录；取回后解压回 EncodedStateReplay。
   *  不存在/超期 → ApiError('NOT_FOUND')。 */
  async getStateReplayShare(shareCode: string): Promise<{ blob: unknown }> {
    const { blob } = await this.request<{ blob: unknown }>('GET', `/r/${shareCode}`);
    return { blob: await unpackReplayBlob(blob) };
  }

  /** L1 录像抽检复算：补传被抽中通关的录像帧 → 第三方无头复算 → 复算星数 ≥ 声称才发材料。 */
  async pveVerify(
    verifyId: string,
    endFrame: number,
    frames: { frame: number; cmds: { side: number; commands: string }[] }[],
  ): Promise<{ save: SaveData; granted: Record<string, number>; capped: boolean; verified: boolean; grantedEquipment?: EquipmentInstance }> {
    return this.post<{
      save: SaveData;
      granted: Record<string, number>;
      capped: boolean;
      verified: boolean;
      grantedEquipment?: EquipmentInstance;
    }>('/pve/verify', { verifyId, endFrame, frames });
  }

  /**
   * @deprecated S3-2 per-stat 升级。S12 起单位养成走集卡合成（{@link pveMerge}）。
   * PvE 升级：服务器校验材料 → 扣材料 + pveUpgrades+1 → 回推。材料不足 → ApiError('INSUFFICIENT_FUNDS')（402）。
   */
  async pveUpgrade(upgradeId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/pve/upgrade', { upgradeId });
  }

  /**
   * 单位养成合成（S12）：服务器校验库存 → 消耗 5 张 N 级卡 → +1 张 N+1 → 重算 unitLevels → 回推。
   * 卡片不足 → ApiError('INSUFFICIENT_FUNDS')（402）；非法兵种/等级 → ApiError('BAD_REQUEST')（400）。
   */
  async pveMerge(unitId: string, level: number): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/pve/merge', { unitId, level });
  }

  // ── 体力系统（A4）──────────────────────────────────────────────────────────

  /** 补体力（A4）：扣 30 金币 → +60 点体力（上限 120）。金币不足 → 402。 */
  async purchaseStamina(): Promise<{ stamina: { current: number; regenAt: number } }> {
    return this.post<{ stamina: { current: number; regenAt: number } }>('/pve/stamina/purchase', {
      amount: 60,
    });
  }

  // ── 装备系统（E2 合成 / E3 强化·分解 / E4 穿戴，服务器权威，需登录 token）────
  // 所有装备动作返回服务器回推的权威 SaveData（equipmentInv/gear/materials/wallet 以服务器为准）。
  // idempotencyKey 由调用方生成（强化绑定掷骰结果，重放不改命）。

  /** 合成一件 +0 基础装备（E2）：扣文具材料 → 入库。材料不足 → 402；满仓 → 409 INVENTORY_FULL。 */
  async craftEquipment(
    defId: string,
    idempotencyKey: string,
  ): Promise<{ save: SaveData; instance: EquipmentInstance }> {
    return this.post<{ save: SaveData; instance: EquipmentInstance }>('/equipment/craft', {
      defId,
      idempotencyKey,
    });
  }

  /**
   * 强化一件装备（E3）：服务器掷骰，成功则 level+1，失败不掉级（success=false）；两种结果都已扣材料+金币。
   * 满级 → 409 ENHANCE_MAX_LEVEL；材料不足 → 402 INSUFFICIENT_MATERIALS；金币不足 → 402 INSUFFICIENT_FUNDS。
   */
  async enhanceEquipment(
    instanceId: string,
    idempotencyKey: string,
    useProtect?: boolean,
  ): Promise<{ success: boolean; instance: EquipmentInstance; save: SaveData }> {
    return this.post<{ success: boolean; instance: EquipmentInstance; save: SaveData }>(
      '/equipment/enhance',
      { instanceId, idempotencyKey, ...(useProtect ? { useProtect: true } : {}) },
    );
  }

  /** 分解一批装备（E3）：+0~4 件返 70% 打造材料、移出库存。+5/穿戴/锁定 → 409。返回返还材料合计。 */
  async salvageEquipment(
    instanceIds: string[],
    idempotencyKey: string,
  ): Promise<{ refunded: Record<string, number>; save: SaveData }> {
    return this.post<{ refunded: Record<string, number>; save: SaveData }>('/equipment/salvage', {
      instanceIds,
      idempotencyKey,
    });
  }

  /**
   * 穿戴 / 卸下一件装备（E4）：instanceId=null 卸下该槽。unitType 缺省=全军共享（gear.global）。
   * 槽位与装备定义不符 → 400 INVALID_SLOT；实例不存在 → 404。
   */
  async equipEquipment(
    slot: EquipSlot,
    instanceId: string | null,
    unitType?: string,
  ): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/equipment/equip', {
      slot,
      instanceId,
      ...(unitType ? { unitType } : {}),
    });
  }

  /** 洗练一件装备（E6）：消耗 materialId，重 roll targetId 副词条；主词条不变。 */
  async reforgeEquipment(
    targetId: string,
    materialId: string,
    idempotencyKey: string,
  ): Promise<{ instance: EquipmentInstance; save: SaveData }> {
    return this.post<{ instance: EquipmentInstance; save: SaveData }>('/equipment/reforge', {
      targetId,
      materialId,
      idempotencyKey,
    });
  }

  /** 最近对战历史（ranked / friendly，按时间倒序；需登录 token）。 */
  async getMatchHistory(limit = 20): Promise<MatchHistoryEntry[]> {
    const data = await this.request<{ matches: MatchHistoryEntry[] }>(
      'GET',
      `/match/history?limit=${limit}`,
    );
    return data.matches;
  }

  /** 取某局服务端录像（仅本人参与；opaque 帧，交 net/serverReplay 解码回放）。404 → ApiError。 */
  async getMatchReplay(roomId: string): Promise<ServerReplay> {
    const data = await this.request<{ replay: ServerReplay }>(
      'GET',
      `/match/${encodeURIComponent(roomId)}/replay`,
    );
    return data.replay;
  }

  // ── 经济：商店 / 盲盒 / 广告 / 充值（S2，需登录 token）────────────
  // 所有花币动作返回服务器回推的权威 SaveData（钱包/库存以服务器为准）。
  // 余额不足 → ApiError('INSUFFICIENT_FUNDS')（402）；票据无效 → ApiError('INVALID_RECEIPT')（400）。

  /** 商品列表（catalog 单一来源在服务端 @nw/shared）。 */
  async getShopItems(): Promise<ShopItem[]> {
    const data = await this.request<{ items: ShopItem[] }>('GET', '/shop/items');
    return data.items;
  }

  /** 直购：扣币 → 发货 → 回推权威存档。 */
  async shopBuy(itemId: string): Promise<{ save: SaveData; granted: string }> {
    return this.post<{ save: SaveData; granted: string }>('/shop/buy', { itemId });
  }

  /** 盲盒池列表（含展开 entries 供展示）。 */
  async getGachaPools(): Promise<GachaPool[]> {
    const data = await this.request<{ pools: GachaPool[] }>('GET', '/gacha/pools');
    return data.pools;
  }

  /** 抽卡（单抽 / 十连，原子，逐抽落库）。 */
  async gachaDraw(
    poolId: string,
    count: 1 | 10,
  ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
    return this.post<{ save: SaveData; results: GachaResultEntry[] }>('/gacha/draw', {
      poolId,
      count,
    });
  }

  /** 广告奖励（每日 cap；超限 → ApiError('DAILY_CAP_REACHED')，429）。 */
  async adsReward(adToken: string): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/ads/reward', { adToken });
  }

  /** 充值验单（票据幂等）。当前服务端 dev 桩：platform/receipt 任意非空即按档发币。 */
  async iapVerify(
    platform: string,
    receipt: string,
  ): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/iap/verify', { platform, receipt });
  }

  // ── 成就（S9-5，需登录 token）────────────────────────────
  /** 成就定义表 + 我的 stats + 已领进度；客户端本地算阶（ACHIEVEMENT_DESIGN §6）。 */
  async getAchievements(): Promise<AchievementsView> {
    return this.request<AchievementsView>('GET', '/achievements');
  }

  /** 领取某成就某阶金币：服务器二次校验 stat≥阈值 + 幂等发币 → 回推权威存档 + 本次发放数。 */
  async claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/achievements/claim', { achId, tier });
  }

  // ── 留存（B5，RETENTION_DESIGN）：签到月历 + 每日任务。 ───────────────────────────────
  /** 读留存状态（月历/每日进度 + 定义表）。 */
  async getRetention(): Promise<RetentionView> {
    return this.request<RetentionView>('GET', '/retention');
  }
  /** 签到领当月下一格奖励（幂等）。 */
  async claimCheckin(): Promise<{ save: SaveData; day: number; reward: { kind: string; count: number } }> {
    return this.post<{ save: SaveData; day: number; reward: { kind: string; count: number } }>('/retention/checkin', {});
  }
  /** 领当日满点任务金币（幂等）。 */
  async claimDailyReward(): Promise<{ save: SaveData; coins: number }> {
    return this.post<{ save: SaveData; coins: number }>('/retention/daily/claim', {});
  }

  // ── 限时活动（B6，ADR-014，需登录 token）──────────────────────────────────
  /** 当前有效活动列表（含本账号参与进度 + 积分商店）。活动期外为空数组。 */
  async getEvents(): Promise<EventView[]> {
    const data = await this.request<{ events: EventView[] }>('GET', '/events');
    return data.events;
  }

  /** 消耗活动积分兑换奖励：发奖落邮件 / commercial 金币。积分不足 → 402；活动期外 → 403。 */
  async claimEventReward(
    eventId: string,
    rewardId: string,
  ): Promise<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }> {
    return this.post<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }>(
      '/events/claim',
      { eventId, rewardId },
    );
  }

  // ── 社交：好友（S6-1，需登录 token）。发送/拉取走 REST，实时事件经 gateway push（NetSession）。──
  /** 好友列表（含在线态）。 */
  async getFriends(): Promise<FriendView[]> {
    const data = await this.request<{ friends: FriendView[] }>('GET', '/friends');
    return data.friends;
  }

  /** 待处理好友申请（收到 + 发出）。 */
  async getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    return this.request<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>(
      'GET',
      '/friends/requests',
    );
  }

  /** 离线红点聚合（SOC8）：登录后一次性拉总未读红点，之后凭 social push 增量更新。 */
  async getSocialBadges(): Promise<SocialBadges> {
    return this.request<SocialBadges>('GET', '/social/badges');
  }

  /** 按 9 位公开 id 搜索玩家。未找到 → ApiError('NOT_FOUND')（404）。 */
  async searchFriend(publicId: string): Promise<ProfileView> {
    const data = await this.post<{ profile: ProfileView }>('/friends/search', { publicId });
    return data.profile;
  }

  /**
   * 发好友申请。已是好友 → ApiError('ALREADY_FRIEND')；超上限 → 'FRIEND_CAP_REACHED'；
   * 被拉黑 → 'BLOCKED'；目标不存在 → 'NOT_FOUND'。
   */
  async requestFriend(publicId: string, message?: string): Promise<string> {
    const data = await this.post<{ requestId: string }>('/friends/request', {
      publicId,
      ...(message ? { message } : {}),
    });
    return data.requestId;
  }

  /** 同意 / 拒绝好友申请（accept=true → 建双向边）。 */
  async respondFriend(requestId: string, accept: boolean): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/respond', { requestId, accept });
  }

  /** 删好友（双向）。 */
  async removeFriend(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/${encodeURIComponent(publicId)}`);
  }

  /** 拉黑（删好友 + 屏蔽申请/私聊）。 */
  async blockUser(publicId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/block', { publicId });
  }

  /** 取消拉黑。 */
  async unblockUser(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/block/${encodeURIComponent(publicId)}`);
  }

  // ── 社交：私聊（S6-2，需登录 token）。发送走 REST，收消息经 gateway push（NetSession）。──
  /** 会话列表（含各自未读数 + 末条摘要）。 */
  async getConversations(): Promise<ConversationView[]> {
    const data = await this.request<{ conversations: ConversationView[] }>('GET', '/chat/conversations');
    return data.conversations;
  }

  /** 拉会话历史（按时间倒序分页）。`before`=游标（epoch ms，取更早的）。 */
  async getMessages(convId: string, before?: number, limit = 30): Promise<ChatMessageView[]> {
    const qs = `?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`;
    const data = await this.request<{ messages: ChatMessageView[] }>(
      'GET',
      `/chat/${encodeURIComponent(convId)}/messages${qs}`,
    );
    return data.messages;
  }

  /** 发私聊。非好友 → ApiError('NOT_FRIEND')；被拉黑 → 'BLOCKED'；限流 → 'RATE_LIMITED'（429）。 */
  async sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }> {
    return this.post<{ messageId: string; ts: number }>('/chat/send', { toPublicId, body });
  }

  /** 标记会话已读（清未读计数）。 */
  async readChat(convId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/chat/read', { convId });
  }

  // ── 社交：邮件（S6-3，需登录 token）。领取经 commercial + inventory，回推权威存档。──
  /** 收件箱（邮件列表 + 未读数）。 */
  async getMail(): Promise<{ mail: MailView[]; unread: number }> {
    return this.request<{ mail: MailView[]; unread: number }>('GET', '/mail');
  }

  /** 标记邮件已读。 */
  async readMail(mailId: string): Promise<void> {
    await this.post<{ ok: boolean }>(`/mail/${encodeURIComponent(mailId)}/read`, {});
  }

  /** 领取附件（发金币/物品，幂等）→ 回推权威存档。已领 → ApiError('ALREADY_CLAIMED')；无附件 → 'NO_ATTACHMENT'。 */
  async claimMail(mailId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>(`/mail/${encodeURIComponent(mailId)}/claim`, {});
  }

  /** 删除邮件。 */
  async deleteMail(mailId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/mail/${encodeURIComponent(mailId)}`);
  }

  /** 玩家间发邮件（门控为好友，无附件）。非好友 → ApiError('NOT_FRIEND')。 */
  async sendMail(toPublicId: string, subject: string, body: string): Promise<string> {
    const data = await this.post<{ mailId: string }>('/mail/send', { toPublicId, subject, body });
    return data.mailId;
  }

  // ── S11 排行榜 / 战令 ──────────────────────────────────────────────────────
  /** Top-100 天梯排行榜（当前赛季 ELO 降序）。 */
  async getLeaderboard(): Promise<{
    seasonNo: number;
    entries: { rank: number; displayName: string; publicId: string; elo: number; pvpRank: string }[];
  }> {
    return this.request<{
      seasonNo: number;
      entries: { rank: number; displayName: string; publicId: string; elo: number; pvpRank: string }[];
    }>('GET', '/leaderboard');
  }

  /** 购买当前赛季战令（600 金币）。 */
  async buyBattlePass(): Promise<{ battlePass: SaveData['battlePass'] }> {
    return this.post<{ battlePass: SaveData['battlePass'] }>('/battlepass/buy', {});
  }

  /** 领取战令奖励（免费轨 or 付费轨）。 */
  async claimBattlePass(
    track: 'free' | 'paid',
    level: number,
  ): Promise<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }> {
    return this.post<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }>(
      '/battlepass/claim',
      { track, level },
    );
  }

  // ── 内部 ────────────────────────────────────────────────
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchRaw(method, path, body);
    const json = (await res.json()) as ApiResp<T>;
    if (!json.ok) {
      log.error(`${method} ${path} -> ${res.status} ${json.error.code}`, json.error.message);
      throw new ApiError(json.error.code, json.error.message);
    }
    log.info(`${method} ${path} -> ${res.status} ok`);
    return json.data;
  }

  private async fetchRaw(
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
      // 网络层失败（服务器没起 / CORS / DNS）：fetch reject 在 console 里很笼统，这里点名 URL。
      log.error(`${method} ${path} network failure`, { url: `${this.baseUrl}${path}`, err: String(e) });
      throw e;
    }
  }
}
