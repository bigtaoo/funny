// Friend + private-chat service — shared deps/error types (SOCIAL_SVC_DESIGN §3.2/§3.3 P2). The
// service itself is split by domain into relations.ts (friend list/requests/block/reports) and
// chat.ts (private messaging), composed by the facade in ../friendService.ts; this file holds the
// types both share.
import type { SocialCollections } from '../db';
import type { SocialGatewayClient } from '../gatewayClient';
import type { SocialMetaClient } from '../metaClient';
import type { WordlistCache } from '@nw/shared';

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
}
