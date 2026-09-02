// Pure type declarations for the FriendsScene composition — split out of core.ts (2026-08-11, form ①
// per claudedocs/client-modules.md's split-form priority note) purely to keep core.ts under the
// 500-line convention. No logic here, just the shared callback/status/tab shapes every domain class
// (and the outer ../FriendsScene.ts assembly) imports.
import type { ProfileExtra } from '../../ui/dialogs/ProfilePopup';
import type { Hit as BaseHit } from '../../ui/hits';
import type { SocialTab } from '../../ui/widgets/socialTabRail';
import type { IPlatform } from '../../platform/IPlatform';
import type {
  FriendView,
  FriendRequestView,
  ProfileView,
  ConversationView,
  MailView,
} from '../../net/ApiClient';
import type { WorldChatMessage, FamilyView, FamilyDetailView } from '../../net/WorldApiClient';

export interface SLGSocialStatus {
  worldId: string;
  familyId?: string;
  familyName?: string;
  familyTag?: string;
  sectId?: string;
  sectName?: string;
  /** Whether the current player is the family leader (only leaders can create sects). */
  isLeader: boolean;
  /** Open join requests awaiting this player's (leader/elder) review — drives the Family tab badge. */
  pendingJoinRequests?: number;
}

export interface FriendsSceneCallbacks {
  onBack(): void;
  onOpenRoom(): void;
  /** Free-text entry surface (ASSET_PACKAGING §4.3/§4.4 item 1) — see IPlatform.openTextInput. Used
   *  by chrome.ts's openHiddenInput() for the family/sect create-forms + world-chat compose box. */
  openTextInput: IPlatform['openTextInput'];
  /** Local player's own public id — used to skip "add friend" on your own world-chat messages. */
  myPublicId: string;
  /** Unified profile-popup extras (rank/ELO + family/sect) — see {@link ProfilePopup}'s `fetchExtra`. */
  getProfileExtra(publicId: string): Promise<ProfileExtra>;
  loadFriends(): Promise<FriendView[]>;
  loadRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>;
  search(publicId: string): Promise<ProfileView>;
  addFriend(publicId: string): Promise<void>;
  respond(requestId: string, accept: boolean): Promise<void>;
  removeFriend(publicId: string): Promise<void>;
  blockUser(publicId: string): Promise<void>;
  reportUser(publicId: string): Promise<void>;
  /** Friend challenge ("切磋"): fire-and-forget, result arrives via applyDuelInvited/applyDuelCancelled pushes. */
  duelInvite(publicId: string): void;
  duelRespond(inviteId: string, accept: boolean): void;
  // Direct chat entry point (triggered from friend profile popup, Tab bar no longer lists it separately)
  loadConversations?(): Promise<ConversationView[]>;
  openChat(peerPublicId: string, peerName: string): void;
  // Mail
  loadMail(): Promise<{ mail: MailView[]; unread: number }>;
  markMailRead(mailId: string): Promise<void>;
  claimMail(mailId: string): Promise<boolean>;
  deleteMail(mailId: string): Promise<void>;
  // SLG social tabs (optional)
  loadSLGStatus?(): Promise<SLGSocialStatus | null>;
  createFamily?(name: string, tag: string): Promise<void>;
  joinFamily?(familyId: string): Promise<void>;
  /** Top-prosperity families with an open slot, or fuzzy-matched by name when `query` is non-empty. */
  browseFamilies?(query?: string): Promise<FamilyView[]>;
  /** Full detail (incl. member roster) for a family being browsed, e.g. to preview it before joining. */
  viewFamily?(familyId: string): Promise<FamilyDetailView>;
  createSect?(name: string, tag: string): Promise<void>;
  joinSect?(sectId: string): Promise<void>;
  /**
   * Jump into the family hub scene (the family tab is a shortcut into it once the player has one).
   * Returns whether it actually navigated — false when the world shard isn't resolved yet, so
   * {@link FriendsSceneCore.autoJumpOrgHub} knows to keep painting this scene instead of leaving a
   * blank page behind a navigation that never happened.
   */
  openFamilyHub?(): boolean;
  /** Same contract as {@link openFamilyHub}, for the sect hub. */
  openSectHub?(): boolean;
  loadWorldChat?(before?: number): Promise<WorldChatMessage[]>;
  sendWorldChat?(body: string, senderName: string): Promise<void>;
  playerName?(): string;
  /** Current coin balance — shown top-right on the world channel tab (each post costs coins). */
  getCoins?(): number;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. the world map underneath) changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /**
   * Re-sync the authoritative wallet after a server-side coin spend (world-chat post).
   * World-chat coins are debited in the commercial service by worldsvc, which never touches
   * the metaserver save mirror the HUD reads — so without this the balance looks unchanged
   * ("post didn't cost anything"). Calling this re-fetches the save (GET /save re-mirrors the
   * live commercial balance) so getCoins() reflects the deduction.
   */
  refreshWallet?(): Promise<void>;
  /** Pre-select a tab on open — used by the lobby mail shortcut (mail) and the world-map chat bar (world). */
  defaultTab?: Tab;
}

export type Tab = SocialTab;
export type View = 'list' | 'search';


/** This scene has a single scrollable region, so `scroll` degrades to a boolean (see ui/hits.ts). */
export type Hit = BaseHit<boolean>;
