// metaserver REST client (S0-5). Covers the endpoints used by S0: auth/device · auth/wx · GET/PUT save.
// Contract = contracts/openapi.yml (unified response envelope ApiResp<T>, optimistic locking via If-Match).
// Economy/gacha (S2) will be added alongside EconomyClient; this file only covers what cloud-save needs.
//
// Transport uses the global fetch (natively supported by Web / CrazyGames). WeChat Mini Game has no fetch (uses wx.request) —
// its cloud sync is scheduled together with WeChat online compliance; currently SaveManager degrades to local-only (offline-first) when baseUrl / fetch is absent.

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch, EquipmentInstance, EquipSlot, CardInstance } from '../game/meta/SaveData';
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
   * @deprecated S3-2 per-stat upgrade. Since CC-1 unit progression is per-card via the Hero Roster (cardInv), not this endpoint.
   * PvE upgrade: server validates materials → deducts materials + increments pveUpgrades by 1 → pushes back. Insufficient materials → ApiError('INSUFFICIENT_FUNDS') (402).
   */
  async pveUpgrade(upgradeId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/pve/upgrade', { upgradeId });
  }

  // ── Stamina system (A4) ──────────────────────────────────────────────────────────

  /** Replenish stamina (A4): costs 30 coins → grants +60 stamina (cap 120). Insufficient coins → 402. */
  async purchaseStamina(): Promise<{ stamina: { current: number; regenAt: number } }> {
    return this.post<{ stamina: { current: number; regenAt: number } }>('/pve/stamina/purchase', {
      amount: 60,
    });
  }

  // ── Equipment system (E2 craft / E3 enhance·salvage / E4 equip, server-authoritative, requires login token) ────
  // All equipment actions return the server-authoritative SaveData (equipmentInv/gear/materials/wallet as per server).
  // idempotencyKey is generated by the caller (enhance binds to the dice roll result, so replays don't change the outcome).

  /** Craft one +0 base equipment piece (E2): deducts stationery materials → adds to inventory. Insufficient materials → 402; inventory full → 409 INVENTORY_FULL. */
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
   * Enhance one equipment piece (E3): server rolls the dice; on success level+1, on failure no level drop (success=false); materials+coins are deducted in both cases.
   * Already max level → 409 ENHANCE_MAX_LEVEL; insufficient materials → 402 INSUFFICIENT_MATERIALS; insufficient coins → 402 INSUFFICIENT_FUNDS.
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

  /** Salvage a batch of equipment (E3): +0~4 pieces refund 70% of crafting materials and are removed from inventory. +5 / equipped / locked → 409. Returns the total refunded materials. */
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
   * Equip / unequip one equipment piece (E4, CC-1): instanceId=null unequips the slot.
   * cardInstanceId required (CC-1 — equipment now lives on the card, not on a global loadout).
   * Slot incompatible with equipment definition → 400 INVALID_SLOT; instance not found → 404.
   */
  async equipEquipment(
    slot: EquipSlot,
    instanceId: string | null,
    cardInstanceId: string,
  ): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/equipment/equip', {
      slot,
      instanceId,
      cardInstanceId,
    });
  }

  /**
   * Feed cards (CC-1): consumes materialCardIds (same-faction), adds XP to targetCardId.
   * Returns the updated SaveData; feed target must not be locked.
   * Material cards that are locked or deployed → 409 CARD_LOCKED.
   */
  async feedCards(
    targetCardId: string,
    materialCardIds: string[],
  ): Promise<{ save: SaveData; levelsGained: number }> {
    return this.post<{ save: SaveData; levelsGained: number }>('/cards/feed', {
      targetCardId,
      materialCardIds,
    });
  }

  /**
   * Toggle card lock (CC-4 client helper): calls POST /cards/lock or /cards/unlock.
   * Locked cards cannot be used as feed material (CC4).
   */
  async setCardLock(cardInstanceId: string, locked: boolean): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>(locked ? '/cards/lock' : '/cards/unlock', { cardInstanceId });
  }

  /** Reforge one equipment piece (E6): consumes materialId, re-rolls targetId's secondary affixes; primary affix unchanged. */
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

  /** Recent match history (ranked / friendly, reverse chronological order; requires login token). */
  async getMatchHistory(limit = 20): Promise<MatchHistoryEntry[]> {
    const data = await this.request<{ matches: MatchHistoryEntry[] }>(
      'GET',
      `/match/history?limit=${limit}`,
    );
    return data.matches;
  }

  /** Retrieve the server-side replay for a match (participants only; opaque frames, decoded for playback by net/serverReplay). 404 → ApiError. */
  async getMatchReplay(roomId: string): Promise<ServerReplay> {
    const data = await this.request<{ replay: ServerReplay }>(
      'GET',
      `/match/${encodeURIComponent(roomId)}/replay`,
    );
    return data.replay;
  }

  // ── Economy: shop / gacha / ads / IAP (S2, requires login token) ────────────
  // All coin-spending actions return the server-authoritative SaveData (wallet/inventory as per server).
  // Insufficient balance → ApiError('INSUFFICIENT_FUNDS') (402); invalid receipt → ApiError('INVALID_RECEIPT') (400).

  /** Shop item list (catalog single source of truth is the server-side @nw/shared). */
  async getShopItems(): Promise<ShopItem[]> {
    const data = await this.request<{ items: ShopItem[] }>('GET', '/shop/items');
    return data.items;
  }

  /** Direct purchase: deduct coins → grant item → push back authoritative save. */
  async shopBuy(itemId: string): Promise<{ save: SaveData; granted: string }> {
    return this.post<{ save: SaveData; granted: string }>('/shop/buy', { itemId });
  }

  /** Gacha pool list (includes expanded entries for display). */
  async getGachaPools(): Promise<GachaPool[]> {
    const data = await this.request<{ pools: GachaPool[] }>('GET', '/gacha/pools');
    return data.pools;
  }

  /** Gacha draw (single / x10, atomic, each result persisted individually). */
  async gachaDraw(
    poolId: string,
    count: 1 | 10,
  ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
    return this.post<{ save: SaveData; results: GachaResultEntry[] }>('/gacha/draw', {
      poolId,
      count,
    });
  }

  /** Ad reward (daily cap; cap exceeded → ApiError('DAILY_CAP_REACHED'), 429). */
  async adsReward(adToken: string): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/ads/reward', { adToken });
  }

  /**
   * IAP receipt verification (idempotent). Native app-store recharge: `platform` is
   * 'apple' / 'google' and `receipt` is the StoreKit / Play Billing receipt from the
   * native bridge; the server verifies it and returns the authoritative save.
   */
  async iapVerify(
    platform: string,
    receipt: string,
  ): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/iap/verify', { platform, receipt });
  }

  /**
   * Web recharge (Paddle): create a checkout transaction for a coin tier (e.g. 't499').
   * Returns the Paddle transactionId the client hands to Paddle.Checkout.open(); coins are
   * credited asynchronously by the /paddle/webhook. Unmapped tier → ApiError('INVALID_TIER');
   * Paddle not configured → ApiError('PADDLE_NOT_CONFIGURED').
   */
  async paddleCheckout(tierId: string): Promise<{ transactionId: string }> {
    return this.post<{ transactionId: string }>('/shop/paddle/checkout', { tierId });
  }

  /**
   * Promo code redemption (B-PROMO): validates code → credits coins → pushes back authoritative save.
   * Invalid/expired code → ApiError('PROMO_NOT_FOUND'); already used → ApiError('PROMO_ALREADY_USED').
   */
  async redeemPromoCode(code: string): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/promo/redeem', { code });
  }

  // ── Achievements (S9-5, requires login token) ────────────────────────────
  /** Achievement definition table + my stats + claimed progress; tier computation is done locally on the client (ACHIEVEMENT_DESIGN §6). */
  async getAchievements(): Promise<AchievementsView> {
    return this.request<AchievementsView>('GET', '/achievements');
  }

  /** Claim coins for an achievement tier: server re-validates stat≥threshold + idempotent coin grant → pushes back authoritative save + amount granted this call. */
  async claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/achievements/claim', { achId, tier });
  }

  // ── Retention (B5, RETENTION_DESIGN): check-in calendar + daily tasks. ───────────────────────────────
  /** Fetch retention state (calendar/daily progress + definition table). */
  async getRetention(): Promise<RetentionView> {
    return this.request<RetentionView>('GET', '/retention');
  }
  /** Check in to claim the next reward in the current month's calendar (idempotent). */
  async claimCheckin(): Promise<{ save: SaveData; day: number; reward: { kind: string; count: number } }> {
    return this.post<{ save: SaveData; day: number; reward: { kind: string; count: number } }>('/retention/checkin', {});
  }
  /** Claim the daily full-points task coin reward (idempotent). */
  async claimDailyReward(): Promise<{ save: SaveData; coins: number }> {
    return this.post<{ save: SaveData; coins: number }>('/retention/daily/claim', {});
  }

  // ── Limited-time events (B6, ADR-014, requires login token) ──────────────────────────────────
  /** Currently active event list (includes this account's participation progress + point shop). Empty array outside the event window. */
  async getEvents(): Promise<EventView[]> {
    const data = await this.request<{ events: EventView[] }>('GET', '/events');
    return data.events;
  }

  /** Spend event points to claim a reward: reward delivered via mail / commercial coins. Insufficient points → 402; outside event window → 403. */
  async claimEventReward(
    eventId: string,
    rewardId: string,
  ): Promise<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }> {
    return this.post<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }>(
      '/events/claim',
      { eventId, rewardId },
    );
  }

  // ── Social: friends (S6-1, requires login token). Send/fetch via REST; real-time events via gateway push (NetSession). ──
  /** Friend list (includes online status). */
  async getFriends(): Promise<FriendView[]> {
    const data = await this.request<{ friends: FriendView[] }>('GET', '/friends');
    return data.friends;
  }

  /** Pending friend requests (received + sent). */
  async getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    return this.request<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>(
      'GET',
      '/friends/requests',
    );
  }

  /** Offline badge aggregate (SOC8): fetched once after login for total unread badge counts; subsequently updated incrementally via social push events. */
  async getSocialBadges(): Promise<SocialBadges> {
    return this.request<SocialBadges>('GET', '/social/badges');
  }

  /** Search for a player by 9-digit public id. Not found → ApiError('NOT_FOUND') (404). */
  async searchFriend(publicId: string): Promise<ProfileView> {
    const data = await this.post<{ profile: ProfileView }>('/friends/search', { publicId });
    return data.profile;
  }

  /**
   * Send a friend request. Already friends → ApiError('ALREADY_FRIEND'); cap exceeded → 'FRIEND_CAP_REACHED';
   * blocked by target → 'BLOCKED'; target not found → 'NOT_FOUND'.
   */
  async requestFriend(publicId: string, message?: string): Promise<string> {
    const data = await this.post<{ requestId: string }>('/friends/request', {
      publicId,
      ...(message ? { message } : {}),
    });
    return data.requestId;
  }

  /** Accept / decline a friend request (accept=true → creates bidirectional edge). */
  async respondFriend(requestId: string, accept: boolean): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/respond', { requestId, accept });
  }

  /** Remove a friend (bidirectional). */
  async removeFriend(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/${encodeURIComponent(publicId)}`);
  }

  /** Block a user (removes friendship + blocks friend requests / private messages). */
  async blockUser(publicId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/block', { publicId });
  }

  /** Unblock a user. */
  async unblockUser(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/block/${encodeURIComponent(publicId)}`);
  }

  // ── Social: private chat (S6-2, requires login token). Send via REST; receive messages via gateway push (NetSession). ──
  /** Conversation list (includes per-conversation unread count + last message snippet). */
  async getConversations(): Promise<ConversationView[]> {
    const data = await this.request<{ conversations: ConversationView[] }>('GET', '/chat/conversations');
    return data.conversations;
  }

  /** Fetch conversation history (paginated, reverse chronological). `before` = cursor (epoch ms, retrieves messages older than this). */
  async getMessages(convId: string, before?: number, limit = 30): Promise<ChatMessageView[]> {
    const qs = `?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`;
    const data = await this.request<{ messages: ChatMessageView[] }>(
      'GET',
      `/chat/${encodeURIComponent(convId)}/messages${qs}`,
    );
    return data.messages;
  }

  /** Send a private chat message. Not friends → ApiError('NOT_FRIEND'); blocked → 'BLOCKED'; rate limited → 'RATE_LIMITED' (429). */
  async sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }> {
    return this.post<{ messageId: string; ts: number }>('/chat/send', { toPublicId, body });
  }

  /** Mark a conversation as read (clears unread count). */
  async readChat(convId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/chat/read', { convId });
  }

  // ── Social: mail (S6-3, requires login token). Claim goes through commercial + inventory, pushes back authoritative save. ──
  /** Inbox (mail list + unread count). */
  async getMail(): Promise<{ mail: MailView[]; unread: number }> {
    return this.request<{ mail: MailView[]; unread: number }>('GET', '/mail');
  }

  /** Mark a mail as read. */
  async readMail(mailId: string): Promise<void> {
    await this.post<{ ok: boolean }>(`/mail/${encodeURIComponent(mailId)}/read`, {});
  }

  /** Claim attachment (grants coins/items, idempotent) → pushes back authoritative save. Already claimed → ApiError('ALREADY_CLAIMED'); no attachment → 'NO_ATTACHMENT'. */
  async claimMail(mailId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>(`/mail/${encodeURIComponent(mailId)}/claim`, {});
  }

  /** Delete a mail. */
  async deleteMail(mailId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/mail/${encodeURIComponent(mailId)}`);
  }

  /** Send mail between players (gated to friends only, no attachments). Not friends → ApiError('NOT_FRIEND'). */
  async sendMail(toPublicId: string, subject: string, body: string): Promise<string> {
    const data = await this.post<{ mailId: string }>('/mail/send', { toPublicId, subject, body });
    return data.mailId;
  }

  // ── S11 leaderboard / battle pass ──────────────────────────────────────────────────────
  /** Top-100 ladder leaderboard (current season ELO descending). */
  async getLeaderboard(): Promise<{
    seasonNo: number;
    entries: { rank: number; displayName: string; publicId: string; elo: number; pvpRank: string }[];
  }> {
    return this.request<{
      seasonNo: number;
      entries: { rank: number; displayName: string; publicId: string; elo: number; pvpRank: string }[];
    }>('GET', '/leaderboard');
  }

  /** Purchase the current season battle pass (600 coins). */
  async buyBattlePass(): Promise<{ battlePass: SaveData['battlePass'] }> {
    return this.post<{ battlePass: SaveData['battlePass'] }>('/battlepass/buy', {});
  }

  /** Claim a battle pass reward (free track or paid track). */
  async claimBattlePass(
    track: 'free' | 'paid',
    level: number,
  ): Promise<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }> {
    return this.post<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }>(
      '/battlepass/claim',
      { track, level },
    );
  }

  // ── Public bootstrap config + targeted client log collection (FEATURE_FLAGS_DESIGN §9, no login required) ──────────────
  /**
   * Fetch the public bootstrap (callable anonymously; token is sent along if held, allowing the server to inject accountId for more precise evaluation).
   * Only flags that differ from their default values are returned (empty object for most players). platform / publicId are passed as query params.
   */
  async getBootstrap(
    platform: string,
    publicId?: string,
  ): Promise<{ flags: Record<string, boolean>; paddleClientToken?: string }> {
    const qs = `?platform=${encodeURIComponent(platform)}${publicId ? `&publicId=${encodeURIComponent(publicId)}` : ''}`;
    return this.request<{ flags: Record<string, boolean>; paddleClientToken?: string }>('GET', `/bootstrap${qs}`);
  }

  /** Upload a batch of client logs (only called for targeted publicIds; server forwards to Loki). Failures are silently swallowed by the caller. */
  async postClientLog(body: {
    publicId: string;
    platform?: string;
    logs: { level: string; msg: string; ts: number; tag?: string }[];
  }): Promise<void> {
    await this.post<{ accepted: number }>('/client/log', body);
  }

  // ── Internal ────────────────────────────────────────────────
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
      // Network-layer failure (server not running / CORS / DNS): fetch rejection is very generic in the console, so we log the URL explicitly here.
      log.error(`${method} ${path} network failure`, { url: `${this.baseUrl}${path}`, err: String(e) });
      throw e;
    }
  }
}
