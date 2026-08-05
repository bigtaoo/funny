// Wire DTOs + hand-written view types for the metaserver REST client (see ../ApiClient.ts assembly).
//
// ── Wire DTOs: sourced from openapi.yml codegen (contracts as single source of truth, `npm run rest:gen`).
//    Contract drift is surfaced at tsc time. SaveData/Rarity still use the client-side meta mirror
//    (domain types, intentionally hand-maintained); purely wire-protocol DTOs (shop/gacha/auth/history) are aliased from the generated schema here.
import type { components, operations } from '../openapi';

type Schemas = components['schemas'];

export type ShopItem = Schemas['ShopItem'];
export type GachaPool = Schemas['GachaPool'];
/** Cumulative recharge milestone reward (GACHA_DESIGN §13, ADR-045). */
export type RechargeReward = Schemas['RechargeReward'];
export type GachaResultEntry = Schemas['GachaResult'];
/** Roster/inventory-full overflow summary from a gacha draw (CHARACTER_CARDS_DESIGN §4 / EQUIPMENT_DESIGN §3.3); all-zero when nothing overflowed. */
export type GachaOverflow =
  operations['gachaDraw']['responses']['200']['content']['application/json']['data']['overflow'];
/** One match history entry (from the perspective of the current account). */
export type MatchHistoryEntry = Schemas['MatchHistoryEntry'];
export type AuthResult = Schemas['AuthResult'];
/** Cached ticket for a still-in-progress match (login-reconnect-prompt): GET /save surfaces this so the client can offer to reconnect. */
export type ActiveMatchInfo = NonNullable<
  operations['getSave']['responses']['200']['content']['application/json']['data']['activeMatch']
>;
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
/**
 * Server-persisted replay (opaque frames, base64). The wire transport is gzip-compressed (`replayGz`,
 * S1-RP storage cost fix) — ApiClient decompresses to this structure via net/serverReplay's
 * decodeReplayGz; net/serverReplay's serverReplayToReplay then decodes it for playback.
 */
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
  /** Weekly active chest progress (§12.3, ISO week key). */
  weekly: { weekKey: string; points: number; claimedTiers: number[] } | null;
  defs: {
    rewards: { kind: string; count: number; id?: string; bonusCoins?: number }[];
    tasks: { id: string; points: number }[];
    pointsThreshold: number;
    dailyCoinsReward: number;
    weeklyChestTiers: { threshold: number; reward: { kind: string; count: number; id?: string } }[];
  };
  claimable: { checkin: boolean; daily: boolean; weeklyTiers: number[] };
  ads: { watchedToday: number; cap: number; rewardCoins: number; cooldownMs: number; nextAvailableAt: number };
}

// —— Aggregated lobby badges (P1-4, comm-audit-2026-07-27) ——
/** GET /lobby/badges response: merges social/achievements/retention/events into one round-trip for lobby entry. */
export type LobbyBadgesView =
  operations['getLobbyBadges']['responses']['200']['content']['application/json']['data'];

export type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
