// Retention (B5) + limited-time events (B6) + season leaderboard/battle pass (S11) + public bootstrap
// config / targeted client log collection (FEATURE_FLAGS_DESIGN §9).
import type { SaveData } from '../../game/meta/SaveData';
import type { ApiClientCore } from './core';
import type { RetentionView, EventView, LobbyBadgesView } from './types';

export interface MiscApi {
  getLobbyBadges(): Promise<LobbyBadgesView>;
  getRetention(): Promise<RetentionView>;
  claimCheckin(): Promise<{
    save: SaveData;
    day: number;
    reward: { kind: string; count: number; id?: string; bonusCoins?: number };
  }>;
  claimDailyReward(): Promise<{ save: SaveData; coins: number }>;
  claimWeeklyChest(
    threshold: number
  ): Promise<{
    save: SaveData;
    threshold: number;
    reward: { kind: string; count: number; id?: string };
  }>;
  getEvents(): Promise<EventView[]>;
  claimEventReward(
    eventId: string,
    rewardId: string
  ): Promise<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }>;
  getLeaderboard(): Promise<{
    seasonNo: number;
    entries: {
      rank: number;
      displayName: string;
      publicId: string;
      elo: number;
      pvpRank: string;
    }[];
    me?: { rank: number; elo: number; pvpRank: string };
  }>;
  submitBotResult(won: boolean): Promise<{ elo: number; rank: string; delta: number }>;
  buyBattlePass(): Promise<{ battlePass: SaveData['battlePass'] }>;
  claimBattlePass(
    track: 'free' | 'paid',
    level: number
  ): Promise<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }>;
  getBootstrap(
    platform: string,
    publicId?: string
  ): Promise<{ flags: Record<string, boolean>; paddleClientToken?: string }>;
  postClientLog(body: {
    publicId: string;
    platform?: string;
    logs: { level: string; msg: string; ts: number; tag?: string }[];
  }): Promise<void>;
}

/** Retention/events/leaderboard/battle-pass/bootstrap domain (see ../ApiClient.ts assembly + ./core.ts for the shared transport). */
export class MiscService implements MiscApi {
  constructor(private readonly core: ApiClientCore) {}

  /** Aggregated lobby red-dot fetch (P1-4, comm-audit-2026-07-27): social badges + achievements + retention/events claimable flags in one round-trip, replacing goLobby()'s old 4-request waterfall. */
  async getLobbyBadges(): Promise<LobbyBadgesView> {
    return this.core.request<LobbyBadgesView>('GET', '/lobby/badges');
  }

  // ── Retention (B5, RETENTION_DESIGN): check-in calendar + daily tasks. ───────────────────────────────
  /** Fetch retention state (calendar/daily progress + definition table). */
  async getRetention(): Promise<RetentionView> {
    return this.core.request<RetentionView>('GET', '/retention');
  }
  /** Check in to claim the next reward in the current month's calendar (idempotent). */
  async claimCheckin(): Promise<{
    save: SaveData;
    day: number;
    reward: { kind: string; count: number; id?: string; bonusCoins?: number };
  }> {
    return this.core.post<{
      save: SaveData;
      day: number;
      reward: { kind: string; count: number; id?: string; bonusCoins?: number };
    }>('/retention/checkin', {});
  }
  /** Claim the daily full-points task coin reward (idempotent). */
  async claimDailyReward(): Promise<{ save: SaveData; coins: number }> {
    return this.core.post<{ save: SaveData; coins: number }>('/retention/daily/claim', {});
  }
  /** Claim one weekly active chest tier (§12.3, idempotent per threshold). */
  async claimWeeklyChest(
    threshold: number
  ): Promise<{
    save: SaveData;
    threshold: number;
    reward: { kind: string; count: number; id?: string };
  }> {
    return this.core.post<{
      save: SaveData;
      threshold: number;
      reward: { kind: string; count: number; id?: string };
    }>('/retention/weekly/claim', { threshold });
  }

  // ── Limited-time events (B6, ADR-014, requires login token) ──────────────────────────────────
  /** Currently active event list (includes this account's participation progress + point shop). Empty array outside the event window. */
  async getEvents(): Promise<EventView[]> {
    const data = await this.core.request<{ events: EventView[] }>('GET', '/events');
    return data.events;
  }

  /** Spend event points to claim a reward: reward delivered via mail / commercial coins. Insufficient points → 402; outside event window → 403. */
  async claimEventReward(
    eventId: string,
    rewardId: string
  ): Promise<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }> {
    return this.core.post<{
      pointsLeft: number;
      reward: { kind: string; id?: string; count?: number };
    }>('/events/claim', { eventId, rewardId });
  }

  // ── S11 leaderboard / battle pass ──────────────────────────────────────────────────────
  /** Top-100 ladder leaderboard (current season ELO descending). */
  async getLeaderboard(): Promise<{
    seasonNo: number;
    entries: {
      rank: number;
      displayName: string;
      publicId: string;
      elo: number;
      pvpRank: string;
    }[];
    me?: { rank: number; elo: number; pvpRank: string };
  }> {
    return this.core.request<{
      seasonNo: number;
      entries: {
        rank: number;
        displayName: string;
        publicId: string;
        elo: number;
        pvpRank: string;
      }[];
      me?: { rank: number; elo: number; pvpRank: string };
    }>('GET', '/leaderboard');
  }

  /**
   * Report the outcome of a client-local AI-fallback (bot) match (matchmaking timed out, no human
   * opponent — MATCHSVC_DESIGN §match_bot_fallback). Always credits the 'pvp.match' daily task;
   * ELO only moves below BOT_ELO_THRESHOLD, and only once per ~15s per account (server-throttled).
   */
  async submitBotResult(won: boolean): Promise<{ elo: number; rank: string; delta: number }> {
    return this.core.post<{ elo: number; rank: string; delta: number }>('/pvp/bot-result', { won });
  }

  /** Purchase the current season battle pass (600 coins). */
  async buyBattlePass(): Promise<{ battlePass: SaveData['battlePass'] }> {
    return this.core.post<{ battlePass: SaveData['battlePass'] }>('/battlepass/buy', {});
  }

  /** Claim a battle pass reward (free track or paid track). */
  async claimBattlePass(
    track: 'free' | 'paid',
    level: number
  ): Promise<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }> {
    return this.core.post<{
      battlePass: SaveData['battlePass'];
      reward: { kind: string; count: number };
    }>('/battlepass/claim', { track, level });
  }

  // ── Public bootstrap config + targeted client log collection (FEATURE_FLAGS_DESIGN §9, no login required) ──────────────
  /**
   * Fetch the public bootstrap (callable anonymously; token is sent along if held, allowing the server to inject accountId for more precise evaluation).
   * Only flags that differ from their default values are returned (empty object for most players). platform / publicId are passed as query params.
   */
  async getBootstrap(
    platform: string,
    publicId?: string
  ): Promise<{ flags: Record<string, boolean>; paddleClientToken?: string }> {
    const qs = `?platform=${encodeURIComponent(platform)}${
      publicId ? `&publicId=${encodeURIComponent(publicId)}` : ''
    }`;
    return this.core.request<{ flags: Record<string, boolean>; paddleClientToken?: string }>(
      'GET',
      `/bootstrap${qs}`
    );
  }

  /** Upload a batch of client logs (only called for targeted publicIds; server forwards to Loki). Failures are silently swallowed by the caller. */
  async postClientLog(body: {
    publicId: string;
    platform?: string;
    logs: { level: string; msg: string; ts: number; tag?: string }[];
  }): Promise<void> {
    await this.core.post<{ accepted: number }>('/client/log', body);
  }
}
