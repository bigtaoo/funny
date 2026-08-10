// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Integrity/anti-cheat domain: PvE replay spot-checks, the shared anti-cheat review queue
// (pvp_overclaim/pve_reject/coin_anomaly), and player appeals against an active enforcement.
import type { Collection } from 'mongodb';
import type { StatKey } from '../achievements';
import type { EquipmentInstance, CardInstance } from '../types';

/**
 * PvE clear replay spot-check re-simulation record (PVE_INTEGRITY §8.6 L1). Sampled clears are recorded here first (materials not yet granted,
 * progress/stars already written); the client then uploads the replay → third-party headless re-simulation via gateway → materials are granted
 * only if the re-simulated star count is >= the claimed count. status:
 * `pending` = awaiting replay, `verified` = re-simulation passed and materials granted, `unverified` = no judge available (benefit-of-doubt, materials granted),
 * `rejected` = re-simulation mismatch, materials not granted (suspicious). `cardInv`/`equipmentInv` are the server-authoritative Hero Roster blueprint snapshot at settlement time (used for re-simulation, prevents drift).
 */
export interface PveVerificationDoc {
  _id: string; // verifyId（uuid）
  accountId: string;
  levelId: string;
  /** Star count claimed by the client (pending re-simulation verification). */
  claimedStars: number;
  /**
   * CC-1 Hero Roster snapshot (2026-07-26 fix, PVE_INTEGRITY §9): server-authoritative `SaveData.cardInv`/`equipmentInv`
   * at settlement time, fed to the L1 judge re-simulation so the recompute uses the player's real card levels/gear
   * instead of the removed pveUpgrades/unitLevels fields (both dead since the engine dropped those GameConfig params
   * in the CC-1 migration — campaign/siege blueprints are built only from cardInstances/equipmentInv).
   */
  cardInv: Record<string, CardInstance>;
  equipmentInv: Record<string, EquipmentInstance>;
  /** Trigger reason (audit): first | anomaly | sample. */
  reason: string;
  status: 'pending' | 'verified' | 'unverified' | 'rejected';
  /** Achievement stats reported by the client for this match (S9-3b): kill/cast counts by type, baseline for audit comparison. */
  reportedStats?: Record<string, number>;
  /** Star count from re-simulation (present when verified or rejected). */
  judgedStars?: number;
  judgeAccountId?: string;
  /**
   * Raw replay frames submitted to `/pve/verify`, archived only when the re-simulation came back `rejected`
   * (PVE_INTEGRITY_PLAN §8.6 待办) — lets ops re-examine a disputed clear after the fact instead of only
   * having the judge's verdict to go on. Absent for `verified`/`unverified` docs to keep the collection lean.
   */
  frames?: { frame: number; cmds: { side: number; commands: string }[] }[];
  endFrame?: number;
  ts: number;
  /** TTL anchor (BSON Date; Mongo TTL only works on Date, `ts` above is a plain number), 2026-07-27 audit
   * finding — mirrors MatchDoc.expireAt's pattern: set at insert (pending), then unset once judged `rejected`
   * (kept forever for ops review, like a disputed match) or left as-is for verified/unverified. */
  expireAt?: Date;
}

/**
 * PvE replay re-simulation rejection audit record (S4-4): one entry written for every pveVerify judged as rejected.
 * Used by the ops admin to review suspicious account history + pveRejectCount three-strike ban audit. _id = verifyId (1-to-1 with pveVerifications).
 */
export interface PveRejectDoc {
  _id: string; // verifyId
  accountId: string;
  levelId: string;
  claimedStars: number;
  judgedStars: number;
  rejectCountAfter: number; // pveRejectCount after this increment
  banned: boolean; // whether this rejection pushed the account over the ban threshold
  ts: number;
}

/**
 * Anti-cheat review queue (S9-7 L2/L3, ACHIEVEMENT_DESIGN §4.4; PvE side added 2026-07-18, PVE_INTEGRITY_PLAN §8.6;
 * coin-anomaly side added 2026-07-26, COMMERCIAL_DESIGN §6.6).
 * Three kinds share one collection/queue: `kind` is absent on pre-existing rows, which are implicitly `'pvp_overclaim'`.
 * - `pvp_overclaim`: an offline audit re-simulation conclusively confirms a side over-reported kill/cast → roll back
 *   the over-reported stats + escalate statSuspicion + write this entry for ops manual review/ban.
 *   `_id = `${roomId}:${accountId}``: one entry per cheating side per match, naturally idempotent (prevents double rollback).
 * - `pve_reject`: a PvE replay spot-check re-simulation yields fewer stars than claimed (`pveVerify`, no automatic ban
 *   as of 2026-07-18 — a legitimate, over-leveled account can clear early content passively with zero input, which is
 *   indistinguishable from a forged empty replay without human judgment). `_id = `pve:${verifyId}``.
 * - `coin_anomaly`: an offline daily scan finds an account whose commercial `ledger` shows more than
 *   `COIN_ANOMALY_DAILY_THRESHOLD` coins gained in one UTC day from non-recharge sources (see
 *   `coinAnomalyAudit.ts` / `commercial`'s `GET /internal/audit/coin-gains`). No automatic action — just a flag for
 *   human review (a legitimate whale-recharge day is excluded by construction; everything else is judgment-call
 *   territory, same reasoning as `pve_reject`). `_id = `coin:${accountId}:${dayKey}``: one entry per account per
 *   flagged day, naturally idempotent against re-scans.
 * Lives in the business database (meta), proxied by admin via `GET /internal/anticheat/reviews` (admin database is
 * physically isolated); resolved (dismiss/ban) via `POST /internal/anticheat/reviews/:id/resolve`.
 */
export interface AntiCheatReviewDoc {
  _id: string; // `${roomId}:${accountId}` (pvp_overclaim) | `pve:${verifyId}` (pve_reject) | `coin:${accountId}:${dayKey}` (coin_anomaly)
  kind?: 'pvp_overclaim' | 'pve_reject' | 'coin_anomaly'; // absent = 'pvp_overclaim' (pre-existing rows, back-compat)
  accountId: string;
  publicId?: string; // snapshot at archive time (for OPS display)
  status: 'open' | 'reviewed';
  ts: number;
  // —— pvp_overclaim fields ——
  roomId?: string;
  side?: number;
  reported?: Partial<Record<StatKey, number>>; // values reported by this side
  authoritative?: Partial<Record<StatKey, number>>; // authoritative values from judge re-simulation
  overclaim?: Partial<Record<StatKey, number>>; // theoretical over-report (reported - authoritative)
  rolledBack?: Partial<Record<StatKey, number>>; // actual rollback amount (clamped to 0 floor)
  suspicionAfter?: number; // statSuspicion for this account after escalation
  judgeAccountId?: string; // re-simulation judge (for auditing)
  // —— pve_reject fields ——
  levelId?: string;
  claimedStars?: number;
  judgedStars?: number;
  rejectCountAfter?: number;
  severity?: 'normal' | 'high'; // 'high' once rejectCountAfter crosses the old auto-ban threshold — triage signal only
  // —— coin_anomaly fields ——
  dayKey?: string; // UTC day (YYYY-MM-DD) the gain was measured over
  nonRechargeGain?: number; // total non-recharge coin gain that day (the amount that tripped the threshold)
  threshold?: number; // threshold in effect at scan time (COIN_ANOMALY_DAILY_THRESHOLD, snapshotted for audit history)
  // —— resolution (all kinds) ——
  resolvedBy?: string; // admin id
  resolvedAt?: number;
  resolution?: 'dismissed' | 'banned';
}

/**
 * Player appeal against a currently-active enforcement (mute/temp-ban/ban) — CONTENT_MODERATION_DESIGN.md
 * CM10. Lives in metaserver (account-level enforcement state is metaserver's authority), proxied by admin
 * via `GET /internal/appeals` / resolved via `POST /internal/appeals/:id/resolve` (same "business service
 * owns the data, admin proxies" shape as AntiCheatReviewDoc above). Approving clears the account's active
 * mute/temp-ban/ban fields but deliberately does NOT restore reputationScore (CM10 — a separate, explicit
 * admin adjustment if warranted).
 */
export interface AppealDoc {
  _id: string; // uuid
  accountId: string;
  reason: string; // player free-text; admin-review-only, not run through censorChat (same rationale as ReportDoc.reason)
  enforcementSnapshot: { banned?: boolean; bannedUntil?: number; mutedUntil?: number; reputationScore?: number };
  status: 'open' | 'approved' | 'denied';
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  resolutionNote?: string;
}

/** Integrity/anti-cheat-domain indexes. */
export async function ensureIntegrityIndexes(
  pveVerifications: Collection<PveVerificationDoc>,
  antiCheatReviews: Collection<AntiCheatReviewDoc>,
  pveRejections: Collection<PveRejectDoc>,
  appeals: Collection<AppealDoc>,
): Promise<void> {
  // PvE spot-check records: query by account + time (audit / clean up pending settlements).
  await pveVerifications.createIndex({ accountId: 1, ts: -1 });
  // TTL safety net (2026-07-27 audit finding: this collection had no expiry at all, and can carry a full
  // replay `frames[]` for rejected docs). Only set for verified/unverified — see PveVerificationDoc.expireAt.
  await pveVerifications.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // achievement anti-cheat review queue (S9-7): query history by account + open queue.
  await antiCheatReviews.createIndex({ accountId: 1, ts: -1 });
  await antiCheatReviews.createIndex({ status: 1, ts: -1 });
  // —— PvE anti-cheat (S4-4) ——
  await pveRejections.createIndex({ accountId: 1, ts: -1 });
  // —— player appeals (CONTENT_MODERATION_DESIGN.md CM10): admin review queue (open first) ——
  await appeals.createIndex({ status: 1, createdAt: 1 });
  // Unique partial index (only matches status:'open' docs): the atomic backstop behind submitAppeal's
  // findOne-then-insert open-appeal guard — two concurrent submits from the same account can both pass
  // the read check, but only one insertOne wins here (E11000), same pattern as equipEquipment's
  // gearInstanceIds unique index.
  await appeals.createIndex({ accountId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
}
