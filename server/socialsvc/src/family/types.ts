// Family business layer — shared view/deps types (SOCIAL_SVC_DESIGN §3/§4, SS2/SS3). The service
// itself is split by domain into query.ts / membership.ts / chat.ts / internal.ts (composed by the
// facade in ../familyService.ts); this file holds the types all four share.
import type { FamilyRole, WordlistCache, EmblemKey } from '@nw/shared';
import type { SocialCollections } from '../db';
import type { SocialGatewayClient } from '../gatewayClient';
import type { SocialMetaClient } from '../metaClient';
import type { MailService } from '../mailService';

export interface FamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  /** Prosperity decay anchor ms (needed by worldsvc to lazily decay sect-aggregate prosperity on read; SLG_DESIGN §17.4). */
  prosperityUpdatedAt?: number;
  /** Territory tile count (worldsvc-owned mirror). */
  territoryCount?: number;
  /** Sect the family currently belongs to (worldsvc-owned mirror; absent = independent family). */
  sectId?: string;
  /** Display name of the sect above, mirrored alongside sectId. */
  sectName?: string;
  announcement?: string;
  /** Family badge (family-emblem-art-prompts.md, 2026-08-14); absent = no badge chosen yet. Leader-only (setEmblem). */
  emblemKey?: EmblemKey;
  /** Accent colour the emblem art is tinted with; absent while emblemKey is absent. */
  emblemColor?: number;
}

/** Membership + family identity in one round trip (internal API, called by worldsvc's requireFamilyLeader). */
export interface FamilyMembershipView {
  familyId: string;
  role: FamilyRole;
  leaderId: string;
  name: string;
  tag: string;
  memberCount: number;
  /** Sect the family belongs to, if any (mirrored from FamilyDoc.sectId/sectName). */
  sectId?: string;
  /** Display name of the sect above, mirrored alongside sectId. */
  sectName?: string;
  /** Family badge (family-emblem-art-prompts.md, 2026-08-14); absent = no badge chosen yet. */
  emblemKey?: EmblemKey;
  /** Accent colour the emblem art is tinted with; absent while emblemKey is absent. */
  emblemColor?: number;
}

export interface FamilyDetailView extends FamilyView {
  members: FamilyMemberView[];
}

export interface FamilyMemberView {
  /** Omitted when the caller is not a member of this family — see getFamily's `callerId` param. */
  accountId?: string;
  role: FamilyRole;
  joinedAt: number;
  /** Resolved via SocialMetaClient.batchProfiles; omitted if metaserver lookup is unavailable or the profile is gone. */
  publicId?: string;
  displayName?: string;
  /** Equipped avatar id (composite "<category>:<key>"), resolved via SocialMetaClient.batchProfiles. */
  avatarId?: string;
}

/** A pending join request as seen by the approving leader/elder (SS3.x join-approval). */
export interface FamilyJoinRequestView {
  requestId: string;
  accountId: string;
  /** Resolved via SocialMetaClient.batchProfiles; omitted if the lookup is unavailable. */
  publicId?: string;
  displayName?: string;
  createdAt: number;
}

export interface FamilyMessageView {
  id: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's family name (家族) — the family itself, since this channel is family-scoped. */
  familyName?: string;
  body: string;
  ts: number;
}

export interface FamilyServiceDeps {
  cols: SocialCollections;
  now: () => number;
  gateway?: SocialGatewayClient;
  meta?: SocialMetaClient;
  /** Used to mail the applicant when their join request is rejected (SS3.x). Omitted in tests that don't exercise that path. */
  mail?: MailService;
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2); omit = built-in REGION_WORDLISTS only. */
  wordlists?: WordlistCache;
}
