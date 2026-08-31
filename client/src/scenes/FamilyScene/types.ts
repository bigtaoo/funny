// Pure type declarations for the family scene — no logic, no imports from any sibling module.
//
// Split out of ./core.ts (2026-08-25) purely to bring it back under the 500-line convention after
// the incremental-repaint pass grew its pointer/scroll section; same seam FriendsScene/types.ts
// already uses (claudedocs/client-modules.md's "Core 本身仍超 500 行时的二次拆分" note). core.ts
// re-exports every name here (`export type {...} from './types'`), so existing
// `from './FamilyScene/core'` imports keep resolving unchanged.
import type { SocialTab } from '../../ui/widgets/socialTabRail';
import type { WorldApiClient, FamilyDetailView, FamilyMessageView } from '../../net/WorldApiClient';

export interface FamilySceneCallbacks {
  onBack(): void;
  /** Open the sect hub (S8-4b) — sect = a family-of-families, rooted in the family UI. */
  onOpenSect(): void;
  /** Rail click for one of the other 4 social tabs (friends/sect/world/mail); 'family' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /**
   * Family detail the opener already fetched, so the first paint doesn't wait on a second identical
   * GET /social/family/mine. Set only by the social hub's family tab, which jumps here right after
   * its own status load pulled exactly this (see createSocialNav's openFamilyHub) — every other
   * entry point omits it and loadData() fetches as before.
   */
  preloadedFamily?: FamilyDetailView;
  /** current player's accountId */
  myAccountId: string;
  /** current player's display name, denormalized onto sent family messages */
  playerName: string;
  /** Send a friend request to another player (unified profile popup's "Add Friend" action). */
  addFriend(publicId: string): Promise<void>;
  /** publicIds of the caller's current friends — gates the profile popup's Add Friend / Message action. */
  getFriendPublicIds(): Promise<Set<string>>;
  /** Open a 1:1 chat with a member who's already a friend (unified profile popup's "Message" action). */
  openChat(peerPublicId: string, peerName: string): void;
}

/** Handle returned by showFamily so the core can push live family-channel messages in. */
export interface FamilySceneView {
  applyFamilyMsg(msg: FamilyMessageView): void;
  /** Live family detail this scene has loaded (null while still loading) — read by nav/world.ts's
   *  onNavTab hand-off so switching to the Sect tab doesn't re-fetch membership already in hand
   *  (see social-tab-switch-cost). */
  getFamily(): FamilyDetailView | null;
}

export type FamilyTab = 'members' | 'channel';
export type ViewMode = 'loading' | 'noFamily' | 'create' | 'myFamily';
