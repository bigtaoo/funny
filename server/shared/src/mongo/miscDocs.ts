// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Misc/ads/events domain: ad-token uniqueness (C2) + time-limited event definitions/participation (B6).
import type { Collection } from 'mongodb';
import type { EventTaskDef, EventRewardDef, EventTaskProgress } from '../events';

/** Ad token uniqueness (C2): SHA-256 hash of adToken, TTL 48h auto-expiry. _id = tokenHash. */
export interface AdsTokenDoc {
  _id: string;   // SHA-256(adToken) hex
  accountId: string;
  ts: number;
  expireAt: Date; // TTL anchor (48h)
}

/**
 * Time-limited event definition (B6, ADR-014). _id = eventId (written by admin).
 * Written by admin via POST /admin/events; no admin UI openapi (pure ops backend, out of scope here).
 */
export interface EventDoc {
  _id: string; // eventId (UUID or ops-defined string)
  title: string; // event name (display)
  description?: string; // short description (optional)
  windowStart: number; // event start timestamp ms (inclusive)
  windowEnd: number;   // event end timestamp ms (exclusive)
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
  createdAt: number;
}

/**
 * Event participation record (B6). _id = `${eventId}:${accountId}`, naturally idempotent.
 * points can only increase; claimedRewards is a list of rewardIds (same id may appear multiple times for multi-claim rewards).
 */
export interface EventParticipantDoc {
  _id: string; // `${eventId}:${accountId}`
  eventId: string;
  accountId: string;
  points: number; // accumulated event points (atomic $inc)
  taskProgress: EventTaskProgress[]; // completion progress for each task
  /** List of claimed rewardIds (push duplicate entries for multi-claim, count by length). */
  claimedRewards: string[];
  updatedAt: number;
}

/** Misc/ads/events-domain indexes. */
export async function ensureMiscIndexes(
  adsTokens: Collection<AdsTokenDoc>,
  events: Collection<EventDoc>,
  eventParticipants: Collection<EventParticipantDoc>,
): Promise<void> {
  // ad token uniqueness TTL auto-expiry (C2, 48h).
  await adsTokens.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // time-limited events (B6): find active events by event window.
  await events.createIndex({ windowStart: 1, windowEnd: 1 });
  // participation records: point-query by event + account (_id is already composite); additional index by accountId to fetch all events a player participates in.
  await eventParticipants.createIndex({ accountId: 1, eventId: 1 });
}
