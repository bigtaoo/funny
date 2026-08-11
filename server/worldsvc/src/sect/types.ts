// Sect business layer — shared view/deps types (S8-4b, SLG_DESIGN §2.1/§8.2). The service itself is
// split by domain into query.ts / membership.ts / chat.ts (composed by the facade in
// ../sectService.ts, familyService.ts's sibling); this file holds the types all three share.
import type { WordlistCache } from '@nw/shared';
import type { WorldCollections } from '../db';
import type { WorldCommercialClient } from '../commercialClient';
import type { WorldGatewayClient } from '../gatewayClient';
import type { WorldSocialsvcClient } from '../socialsvcClient';
import type { WorldMetaClient } from '../metaClient';

export interface SectView {
  sectId: string;
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string;
  leaderId: string;
  memberFamilyCount: number;
  allySectIds: string[];
  prosperity: number;
}

export interface SectMemberFamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  territoryCount: number;
}

export interface SectDetailView extends SectView {
  memberFamilies: SectMemberFamilyView[];
  removalVote?: { nomineeFamilyId: string; voteCount: number; needed: number };
}

export interface SectMessageView {
  id: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's sect name (宗门) — the sect itself, since this channel is sect-scoped. */
  sectName?: string;
  /** Sender's family name (家族), if any. */
  familyName?: string;
  body: string;
  ts: number; // ms since epoch
}

export interface SectServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial?: WorldCommercialClient;
  /** Real-time channel fan-out (S8-4b); default = no gateway, REST polling only. */
  gateway?: WorldGatewayClient;
  /** socialsvc client: family identity/roster + sectId mirror writes (SOCIAL_SVC_DESIGN §5 push delegation, P4-follow-up family lookups); default = no family data available. */
  socialsvc?: WorldSocialsvcClient;
  /** meta client for publicId resolution in chat messages; default = fromPublicId left empty. */
  meta?: WorldMetaClient;
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2); omit = built-in REGION_WORDLISTS only. */
  wordlists?: WordlistCache;
}
