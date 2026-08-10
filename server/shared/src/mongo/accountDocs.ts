// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Account/save domain: identity + save-doc shape + the ladder leaderboard index that lives on
// `saves` (pvp elo is stored inside SaveData, not a separate collection) + real-time stamina state.
import type { Collection } from 'mongodb';
import type { SaveData } from '../types';
import type { ChatRegion } from '../chatFilter';

export interface SaveDoc {
  _id: string; // accountId
  save: SaveData;
  rev: number;
}

export interface AccountDoc {
  _id: string; // accountId
  createdAt: number;
  // —— Credentials (each optional, at least one required) ——
  deviceId?: string; // anonymous device (sparse unique)
  openid?: string; // WeChat (sparse unique)
  password?: {
    // email/username password (ACCOUNT_DESIGN §2.2)
    loginId: string; // normalized email/username (sparse unique)
    hash: string; // scrypt (shared/password.ts)
  };
  oauth?: { provider: string; sub: string }[]; // third-party (provider+sub unique, SA-2)
  // —— Profile ——
  displayName?: string;
  /**
   * Whether the player has deliberately chosen their display name — set on password registration with an
   * explicit name, or after any rename. Absent/false means the current `displayName` is a system-assigned
   * default (lazy backfill via {@link ensureDisplayName}, or never set): the player is entitled to one
   * **free** rename (see metaserver profileRename). Once true, renames cost RENAME_COST coins.
   */
  nameChosen?: boolean;
  /** 9-digit numeric public id (globally unique, used for player communication/reports). Lazily generated on first auth. */
  publicId?: string;
  /**
   * Compliance region code (SOC10). Lazily inferred and refreshed from the `Accept-Language` header on auth (best-effort).
   * Private-chat sensitive-word filtering uses the sender's region to select the word list; absent / legacy accounts → `'global'` (basic word list only).
   */
  region?: ChatRegion;
  /** C4 PvE anti-cheat: suspicious attempt count + ban flag (account level, used to block auth). */
  flags?: {
    pveWarnings?: number; // cumulative PvE suspicious attempt count (visibility only, no longer a ban trigger — see AntiCheatReviewDoc pve_reject)
    banned?: boolean;     // set only via ops manual ban (anticheat.action) after human review; auth returns ACCOUNT_BANNED
    gdprConsent?: boolean; // C5-c GDPR consent (must be true to record analytics events)
    /** CONTENT_MODERATION_DESIGN.md CM6: content-moderation reputation, 0-100, absent = 100 (never penalized). Only written by POST /internal/accounts/:id/penalty (the sole enforcement-execution path) and the daily decay sweep. */
    reputationScore?: number;
    /** CM8.1: next time this account is eligible for the +10 automatic decay tick; absent once fully healed (score===100). */
    reputationDecayAt?: number;
    /** CM6: epoch ms until which chat sends are rejected (checked at sendMessage call sites, not at login — independent of `banned`/`bannedUntil`). */
    mutedUntil?: number;
    /** CM6: epoch ms until which auth is rejected (temp ban); checked alongside `banned` in rejectIfBanned. Auto-expires — no unban action needed. */
    bannedUntil?: number;
    /**
     * Optimistic-lock counter for the reputationScore/mutedUntil/bannedUntil/banned quartet above (mirrors
     * SaveDoc.rev): applyPenalty and the daily decay sweep both do read-compute-write against this same
     * quartet, and a plain read-then-$set race between them (or two concurrent penalties) can silently lose
     * one side's update. Every writer guards its update on this value matching what it read and $inc's it —
     * a stale writer's matchedCount comes back 0 and it re-reads + retries instead of overwriting.
     */
    moderationRev?: number;
  };
  /** C5-b soft-delete timestamp; once set, auth returns ACCOUNT_DELETED and data is asynchronously purged after 7 days. */
  deletedAt?: number;
  /**
   * C5-b cancellation token, minted alongside deletedAt and required by POST /account/cancel-deletion
   * to undo a soft-delete within the 7-day grace period. Cleared (along with deletedAt) on successful
   * cancellation, or once the grace period elapses (the eventual purge job clears the whole account).
   */
  deletionConfirmToken?: string;
}

/**
 * Whether the account is anonymous: only a device credential attached, no recoverable credentials (password/oauth/wx).
 * Multiplayer/store/recharge require isAnonymous=false (ACCOUNT_DESIGN §2.2). Computed on-the-fly, not persisted, to avoid drift.
 */
export function isAnonymousAccount(doc: AccountDoc): boolean {
  return !doc.openid && !doc.password && !(doc.oauth && doc.oauth.length > 0);
}

// gachaHistory / walletLog / iapReceipts have been moved out of the meta database (S5, COMMERCIAL_DESIGN §8.1):
// wallet/ledger/gacha history/recharge receipts now live in the commercial service's dedicated database `notebook_wars_commercial`
// as wallets/ledger/orders/recharges/gachaHistory. meta no longer owns these collections.

/** Stamina real-time state (A4). _id = accountId. Whole-row atomic findOneAndUpdate deduction, no rev lock. */
export interface StaminaDoc {
  _id: string; // accountId
  current: number; // current stamina (0..120)
  regenAt: number; // timestamp (ms) of the next +1 regen tick; 0 when already full
}

/** Account/save-domain indexes (accounts + the ladder leaderboard index that lives on saves). */
export async function ensureAccountIndexes(
  saves: Collection<SaveDoc>,
  accounts: Collection<AccountDoc>,
): Promise<void> {
  await accounts.createIndex({ openid: 1 }, { sparse: true, unique: true });
  await accounts.createIndex({ deviceId: 1 }, { sparse: true, unique: true });
  // password login loginId uniqueness (SA-1); oauth provider+sub uniqueness (SA-2, pre-built).
  await accounts.createIndex({ 'password.loginId': 1 }, { sparse: true, unique: true });
  await accounts.createIndex({ 'oauth.provider': 1, 'oauth.sub': 1 }, { sparse: true, unique: true });
  // 9-digit numeric public id globally unique (sparse, lazily back-filled for legacy accounts).
  await accounts.createIndex({ publicId: 1 }, { sparse: true, unique: true });
  // CONTENT_MODERATION_DESIGN.md CM8.1: reputation-decay daily sweep scans accounts due for a tick.
  // Partial index (only documents where the field exists) — same pattern as worldsvc's
  // nextBuildCompleteAt/nextTrainingCompleteAt — keeps the scan to the (small) penalized-account
  // subset instead of a full collection scan; the field is cleared once an account fully heals to 100.
  await accounts.createIndex(
    { 'flags.reputationDecayAt': 1 },
    { partialFilterExpression: { 'flags.reputationDecayAt': { $exists: true } } },
  );
  // ladder leaderboard: server-wide Top100 + my rank count (S11-SE-5).
  // filter by pvp.seasonNo for the current season, then take the top 100 sorted by elo descending.
  await saves.createIndex({ 'save.pvp.seasonNo': 1, 'save.pvp.elo': -1 }, { name: 'pvp_season_elo' });
  // stamina (A4): _id = accountId, single-document collection, no additional indexes.
}
