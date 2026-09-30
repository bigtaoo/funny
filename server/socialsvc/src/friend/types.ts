// Friend + private-chat service — shared deps/error types (SOCIAL_SVC_DESIGN §3.2/§3.3 P2). The
// service itself is split by domain into relations.ts (friend list/requests/block/reports) and
// chat.ts (private messaging), composed by the facade in ../friendService.ts; this file holds the
// types both share.
import type { SocialCollections } from '../db';
import type { SocialGatewayClient } from '../gatewayClient';
import type { SocialMetaClient } from '../metaClient';
import type { WordlistCache, ReportCategory, ReportChannel } from '@nw/shared';
import type { ReportAlerter } from '../reportAlert';

export type SocialError =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'ALREADY_FRIEND'
  | 'FRIEND_CAP_REACHED'
  | 'NOT_FRIEND'
  | 'BLOCKED'
  | 'MUTED';

export interface FriendServiceDeps {
  cols: SocialCollections;
  gateway: SocialGatewayClient;
  meta: SocialMetaClient;
  now: () => number;
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2); omit = built-in REGION_WORDLISTS only. */
  wordlists?: WordlistCache;
  /** New-report webhook alert (Guideline 1.2); omit = no alert (tests, or NW_ALERT_WEBHOOK_URL unset). */
  alerts?: ReportAlerter;
}

/**
 * Optional detail on a report or block (App Store Review Guideline 1.2). `content.text` is the reporter's
 * client-side snapshot; for socialsvc-owned channels a `messageId` lets the server store the real text instead.
 */
export interface ReportInput {
  reason?: string;
  category?: ReportCategory;
  content?: { channel: ReportChannel; messageId?: string; text?: string };
}

/** One row of GET /social/friends/blocked. */
export interface BlockedView {
  publicId: string;
  displayName: string;
  ts: number;
}
