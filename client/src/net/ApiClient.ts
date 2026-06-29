// metaserver REST client (S0-5). Covers the endpoints used by S0: auth/device · auth/wx · GET/PUT save.
// Contract = contracts/openapi.yml (unified response envelope ApiResp<T>, optimistic locking via If-Match).
// Economy/gacha (S2) will be added alongside EconomyClient; this file only covers what cloud-save needs.
//
// Transport uses the global fetch (natively supported by Web / CrazyGames). WeChat Mini Game has no fetch (uses wx.request) —
// its cloud sync is scheduled together with WeChat online compliance; currently SaveManager degrades to local-only (offline-first) when baseUrl / fetch is absent.

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch, EquipmentInstance, EquipSlot } from '../game/meta/SaveData';
import type { components, operations } from './openapi';
import { netLog } from './log';
import { packReplayBlob, unpackReplayBlob } from './replayCompress';

const log = netLog('api');

// ── Wire DTOs: sourced from openapi.yml codegen (contracts as single source of truth, `npm run rest:gen`).
//    Contract drift is surfaced at tsc time. SaveData/SyncPatch/Rarity still use the client-side meta mirror
//    (domain types, intentionally hand-maintained); purely wire-protocol DTOs (shop/gacha/auth/history) are aliased from the generated schema here.
type Schemas = components['schemas'];

export type ShopItem = Schemas['ShopItem'];
export type GachaPool = Schemas['GachaPool'];
export type GachaEntry = GachaPool['entries'][number];
export type GachaResultEntry = Schemas['GachaResult'];
/** One match history entry (from the perspective of the current account). */
export type MatchHistoryEntry = Schemas['MatchHistoryEntry'];
export type AuthResult = Schemas['AuthResult'];
// —— Social (S6-1 friends / S6-2 private chat / S6-3 mail) ——
export type ProfileView = Schemas['ProfileView'];
export type FriendView = Schemas['FriendView'];
export type FriendRequestView = Schemas['FriendRequestView'];
export type ConversationView = Schemas['ConversationView'];
export type ChatMessageView = Schemas['ChatMessageView'];
export type MailView = Schemas['MailView'];
export type MailAttachmentView = Schemas['MailAttachmentView'];
/** Offline badge aggregate (friend requests / unread conversations / unread mail + total); fetched once after login. */
export type SocialBadges = Schemas['SocialBadges'];
/** Server-persisted replay (opaque frames, base64); decoded for playback on the client via net/serverReplay. */
export type ServerReplay = Schemas['MatchReplay'];
// —— Achievement system (S9-5) ——
/** Achievement definition (hard-coded in @nw/shared, delivered by the server; the client uses it together with stats to compute tiers locally). */
export type Achievement = Schemas['Achievement'];
/** GET /achievements response: definition table + my stats + claimed progress. */
export type AchievementsView =
  operations['getAchievements']['responses']['200']['content']['application/json']['data'];
// —— Limited-time events (B6, ADR-014) ——
/** One event entry in the GET /events response (includes task progress + point shop). EventScene's view type is compatible with this structure. */
export type EventView =
  operations['getEvents']['responses']['200']['content']['application/json']['data']['events'][number];
// —— Retention system (B5, RETENTION_DESIGN) ——
/** GET /retention response: check-in calendar + daily tasks + definition table + badge counts. */
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

/** PUT /save result: on success, returns the normalised save; on 409 conflict, returns the current server-side value. */
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

  /** @param baseUrl e.g. https://host/api (no trailing slash). */
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

  // ── auth (S0-4 / S0-7) ──────────────────────────────────
  /** Exchange a platform anonymous credential for a token + accountId; on success the token is retained automatically. */
  async auth(cred: AuthCredential): Promise<AuthResult> {
    const path = cred.kind === 'wx' ? '/auth/wx' : '/auth/device';
    const body = cred.kind === 'wx' ? { code: cred.code } : { deviceId: cred.deviceId };
    const data = await this.post<AuthResult>(path, body);
    this.token = data.token;
    return data;
  }

  // ── Password account (SA-1) ─────────────────────────────────────
  /** Password-based registration (new account); on success the token is retained automatically. */
  async register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/register', {
      loginId,
      password,
      ...(displayName ? { displayName } : {}),
    });
    this.token = data.token;
    return data;
  }

  /** Password-based login; on success the token is retained automatically. */
  async login(loginId: string, password: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/login', { loginId, password });
    this.token = data.token;
    return data;
  }

  /** Change password (requires an active login; token must already be held). */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.post<{ ok: true }>('/auth/password/change', { oldPassword, newPassword });
  }

  // ── Account compliance (C5, requires login token) ────────────────────────────────────────────
  /**
   * Soft-delete account (C5-b, Apple 5.1.1(v)): server sets `deletedAt`; data is purged asynchronously after a 7-day grace period.
   * Re-logging in during the grace period restores the account. Returns a confirmation token (for auditing). Callers should clear the local token/save and return to the login screen.
   */
  async deleteAccount(): Promise<{ confirmToken: string }> {
    return this.request<{ confirmToken: string }>('DELETE', '/account');
  }

  /** Record GDPR consent (C5-c): server writes `flags.gdprConsent`. Must not be called when no token is held (anonymous / not logged in). */
  async recordGdprConsent(consent: boolean): Promise<void> {
    await this.post<{ ok: true }>('/account/gdpr-consent', { consent });
  }

  // ── save (S0-7) ─────────────────────────────────────────
  /** Fetch the current account's cloud save (also returns the display name + public id + gateway URL for use in the profile / online play). */
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

  /** Rename (costs coins). Returns the authoritative save + new display name; insufficient balance → ApiError('INSUFFICIENT_FUNDS'). */
  async rename(displayName: string): Promise<{ save: SaveData; displayName: string }> {
    return this.post<{ save: SaveData; displayName: string }>('/profile/rename', { displayName });
  }

  /**
   * Push a client sync patch with optimistic locking via If-Match: rev.
   * 200 → ok + normalised save; 409 → conflict + current server-side value (no exception thrown; caller handles pull-merge).
   */
  async putSave(rev: number, patch: SyncPatch): Promise<PushResult> {
    const res = await this.fetchRaw('PUT', '/save', { save: patch }, { 'If-Match': String(rev) });
    const json = (await res.json()) as ApiResp<{ save: SaveData }> & { save?: SaveData };
    if (res.status === 409) {
      // 409 envelope: { ok:false, error, save: current server-side value }
      if (json.save) return { kind: 'conflict', save: json.save };
      throw new ApiError('REV_CONFLICT', 'rev conflict without server save');
    }
    if (!json.ok) {
      throw new ApiError(json.error.code, json.error.message);
    }
    return { kind: 'ok', save: json.data.save };
  }

  // ── PvE server authority (PVE_INTEGRITY_PLAN §8, requires login token) ─────────────
  // progress/stars/materials/pveUpgrades are server-authoritative fields; level completion and upgrades go through these two endpoints,
  // which return the full authoritative SaveData (client adopts the mirror). Only callable when online.

  /**
   * PvE level-clear settlement: server validates the unlock → grants materials + cards within the daily cap → writes progress/stars → pushes back.
   * L1 sampling check (§8.6 step 3): when the request is sampled, returns `needsReplay + verifyId` (materials held back); the caller must submit the replay via {@link pveVerify} for re-computation and crediting.
   * `unitLevels` is the client-side unit blueprint snapshot at game start (L0 anomaly detection, S12).
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

  /** Create a replay share link (S1-RP): 7-day TTL; anyone with the shareId can retrieve the replay (no login required). */
  async createReplayShare(roomId: string): Promise<{ shareId: string }> {
    return this.post<{ shareId: string }>(`/match/${roomId}/replay/share`, {});
  }

  /** Retrieve a replay via share link (S1-RP): no login required. */
  async getReplayByShare(shareId: string): Promise<{ replay: unknown }> {
    return this.request<{ replay: unknown }>('GET', `/share/replay/${shareId}`);
  }

  /**
   * Out-of-game sharing of a state-stream replay — mint a share code (REPLAY_SHARE_DESIGN §3.1): uploads the client-generated state-stream blob
   * and returns an unguessable shareCode. Login required. The blob is gzip+base64 compressed before upload (repetitive delta JSON compresses extremely well, §7);
   * the server stores it opaquely. Size exceeded / rate limited → ApiError('BAD_REQUEST' / 'RATE_LIMITED').
   */
  async createStateReplayShare(blob: unknown): Promise<{ shareCode: string }> {
    const packed = await packReplayBlob(blob);
    return this.post<{ shareCode: string }>('/replay/share', { blob: packed });
  }

  /** Public retrieval of a state-stream replay (REPLAY_SHARE_DESIGN §3.2): no login required; decompresses back to EncodedStateReplay after retrieval.
   *  Not found / expired → ApiError('NOT_FOUND'). */
  async getStateReplayShare(shareCode: string): Promise<{ blob: unknown }> {
    const { blob } = await this.request<{ blob: unknown }>('GET', `/r/${shareCode}`);
    return { blob: await unpackReplayBlob(blob) };
  }

  /** L1 replay sampling re-computation: submit the replay frames for a sampled level clear → headless third-party re-computation → materials are granted only if the computed stars meet or exceed the claimed value. */
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

  // ── 公开启动配置 + 客户端日志定向采集（FEATURE_FLAGS_DESIGN §9，无需登录）──────────────
  /**
   * 拉公开 bootstrap（匿名可调；持有 token 则带上、服务端注入 accountId 求值更精确）。
   * 只回与默认值不同的 flag（多数玩家为空对象）。platform / publicId 经 query 带入。
   */
  async getBootstrap(platform: string, publicId?: string): Promise<{ flags: Record<string, boolean> }> {
    const qs = `?platform=${encodeURIComponent(platform)}${publicId ? `&publicId=${encodeURIComponent(publicId)}` : ''}`;
    return this.request<{ flags: Record<string, boolean> }>('GET', `/bootstrap${qs}`);
  }

  /** 上报一批客户端日志（仅被定向的 publicId 调用；服务端转发 Loki）。失败由调用方静默吞掉。 */
  async postClientLog(body: {
    publicId: string;
    platform?: string;
    logs: { level: string; msg: string; ts: number; tag?: string }[];
  }): Promise<void> {
    await this.post<{ accepted: number }>('/client/log', body);
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
