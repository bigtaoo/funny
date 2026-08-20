// Networking: all async API/callback methods (refresh + SLG/world loads + friend/family/sect/world/mail actions).
// Every body just calls the injected callbacks (core.cb.*) and updates core state + re-renders.
//
// NetworkPanel has no dependency on any other domain class — every tab panel (friendsList/search/
// orgForm/worldChat/mail) depends on IT (2026-08-11 converted from the former `XMixin(Base)`
// inheritance chain to an independent class over `core`, per claudedocs/client-modules.md's
// split-form priority note).
import { TranslationKey } from '../../i18n';
import type { FriendsSceneCore } from './core';
import type { MailView } from '../../net/ApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { loadEmblemAtlas } from '../../render/emblemIcon';

export interface NetworkHandlers {
  refresh(): Promise<void>;
  loadSLGStatus(): Promise<void>;
  loadWorldMessages(): Promise<void>;
  doSearch(): Promise<void>;
  doAdd(publicId: string): Promise<void>;
  doRespond(requestId: string, accept: boolean): Promise<void>;
  doRemove(publicId: string): Promise<void>;
  doBlock(publicId: string): Promise<void>;
  doReport(publicId: string): Promise<void>;
  doDuel(publicId: string): void;
  doDuelRespond(inviteId: string, accept: boolean): void;
  doCreateFamily(): Promise<void>;
  loadFamilyBrowse(query: string): Promise<void>;
  doJoinFamily(familyId: string): Promise<void>;
  doCreateSect(): Promise<void>;
  doJoinSect(): Promise<void>;
  doSendWorldChat(): Promise<void>;
  doClaim(m: MailView): Promise<void>;
  doMailDelete(m: MailView): Promise<void>;
}

export class NetworkPanel implements NetworkHandlers {
  constructor(private readonly core: FriendsSceneCore) {}

  // ── Data ───────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const core = this.core;
    const wasLoading = core.loading;
    try {
      const [friends, requests, mail, convs] = await Promise.all([
        core.cb.loadFriends(),
        core.cb.loadRequests(),
        core.cb.loadMail(),
        // Unread chat feeds the friend-row unread bubble + Friends tab dot (see conversations doc).
        core.cb.loadConversations?.() ?? Promise.resolve([]),
      ]);
      core.friends = friends;
      core.incoming = requests.incoming;
      core.mail = mail.mail;
      core.mailUnread = mail.unread;
      core.conversations = convs;
      core.lastRefreshAt = Date.now();
    } catch {
      if (core.loading) core.toast('friends.error');
    } finally {
      core.loading = false;
      // refresh() runs on every inbound push (presence/request/chat/mail) and on a stale tab switch,
      // and most of those land with an identical payload — repainting anyway meant a second, network-
      // delayed full rebuild flashing over whatever the player was already looking at (or typing
      // into). Only repaint when the first load just finished or the data actually moved.
      const sig = refreshSignature(core);
      const changed = sig !== core.refreshSig;
      core.refreshSig = sig;
      if (!core.dead && (wasLoading || changed)) core.render();
    }
  }

  async loadSLGStatus(): Promise<void> {
    const core = this.core;
    if (!core.cb.loadSLGStatus || core.slgLoading) return;
    core.slgLoading = true;
    core.render();
    try {
      core.slgStatus = await core.cb.loadSLGStatus();
      // Approval landed (or the leader rejected — either way the pending request is
      // resolved server-side) — a still-pending request always keeps familyId unset.
      if (core.slgStatus?.familyId) core.familyJoinPending = false;
    } catch {
      core.slgStatus = null;
    } finally {
      core.slgLoading = false;
      core.slgLoaded = true;
      // This status is what decides whether the family/sect tab is a page or a jump into its own hub
      // scene, so resolve that here rather than in drawFamilyTab/drawSectTab — those used to navigate
      // (and so destroy this scene) from inside render(). Skip the repaint when we're leaving anyway.
      if (!core.dead && !core.autoJumpOrgHub()) core.render();
    }
  }

  async loadWorldMessages(): Promise<void> {
    const core = this.core;
    if (!core.cb.loadWorldChat || core.worldLoading) return;
    core.worldLoading = true;
    core.worldLoadError = false;
    if (!core.dead) core.render();
    try {
      const msgs = await core.cb.loadWorldChat();
      core.worldMessages = msgs.slice().reverse(); // server newest-first → oldest-first for display
      core.worldLoaded = true;
    } catch {
      core.worldLoadError = true;
    } finally {
      core.worldLoading = false;
    }
    if (!core.dead) core.render();
  }

  async doSearch(): Promise<void> {
    const core = this.core;
    if (core.searchDigits.length === 0) return;
    const id = core.searchDigits.join('');
    core.searchResult = null;
    core.searchMsgKey = 'friends.searching';
    core.render();
    try {
      core.searchResult = await core.cb.search(id);
      core.searchMsgKey = null;
    } catch {
      core.searchResult = null;
      core.searchMsgKey = 'friends.notFound';
    }
    core.render();
  }

  async doAdd(publicId: string): Promise<void> {
    const core = this.core;
    try {
      await core.cb.addFriend(publicId);
      core.toast('friends.requestSent', 'success');
      core.view = 'list';
      core.render();
      void this.refresh();
    } catch (e) {
      core.toast(addErrorKey(e));
      core.render();
    }
  }

  async doRespond(requestId: string, accept: boolean): Promise<void> {
    const core = this.core;
    try { await core.cb.respond(requestId, accept); } catch { core.toast('friends.error'); }
    void this.refresh();
  }

  async doRemove(publicId: string): Promise<void> {
    const core = this.core;
    core.popup.hide();
    try { await core.cb.removeFriend(publicId); core.toast('friends.removed', 'success'); } catch { core.toast('friends.error'); }
    void this.refresh();
  }

  async doBlock(publicId: string): Promise<void> {
    const core = this.core;
    try { await core.cb.blockUser(publicId); core.toast('friends.blockedDone', 'success'); } catch { core.toast('friends.error'); }
    void this.refresh();
  }

  /** UGC report (design-doc-audit-2026-07, COMPLIANCE_GLOBAL.md §7): admin-review-only, does not block/unfriend. */
  async doReport(publicId: string): Promise<void> {
    const core = this.core;
    try { await core.cb.reportUser(publicId); core.toast('friends.reportedDone', 'success'); } catch { core.toast('friends.error'); }
  }

  doDuel(publicId: string): void {
    const core = this.core;
    core.sendingDuelTo = publicId;
    core.cb.duelInvite(publicId);
    core.render();
  }

  doDuelRespond(inviteId: string, accept: boolean): void {
    const core = this.core;
    core.incomingDuelInvite = null;
    core.cb.duelRespond(inviteId, accept);
    core.render();
  }

  async doCreateFamily(): Promise<void> {
    const core = this.core;
    const name = core.familyCreateName.trim();
    const tag = core.familyCreateTag.trim().toUpperCase();
    if (!name || !tag) return;
    core.clearHiddenInput();
    try {
      await core.cb.createFamily?.(name, tag);
      core.toast('social.family.created', 'success');
      core.familySubview = 'info';
      core.familyCreateName = '';
      core.familyCreateTag = '';
      core.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      core.toast('social.family.createFail');
    }
    core.render();
  }

  async loadFamilyBrowse(query: string): Promise<void> {
    const core = this.core;
    core.familyBrowseLoading = true;
    core.render();
    try {
      core.familyBrowseResults = await core.cb.browseFamilies?.(query) ?? [];
    } catch {
      core.familyBrowseResults = [];
    } finally {
      core.familyBrowseLoading = false;
      core.familyBrowseLoaded = true;
    }
    // Emblem atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts); kick it off once any browsed
    // family shows a badge, re-rendering once it resolves (orgForm.ts's drawFamilyBrowseList badges).
    if (core.familyBrowseResults.some((f) => f.emblemKey)) {
      void loadEmblemAtlas().then(() => { if (!core.dead) core.render(); }).catch(() => {});
    }
    if (!core.dead) core.render();
  }

  async doJoinFamily(familyId: string): Promise<void> {
    const core = this.core;
    if (!familyId) return;
    core.clearHiddenInput();
    try {
      await core.cb.joinFamily?.(familyId);
      core.toast('social.family.joinRequested', 'success');
      core.familyJoinPending = true;
      core.familySubview = 'info';
      core.familyBrowseQuery = '';
      core.familyBrowseResults = [];
      core.familyBrowseLoaded = false;
      core.familyDetailView = null;
      core.slgLoaded = false;
      void this.loadSLGStatus();
    } catch (e) {
      // ALREADY_REQUESTED means an earlier request (this session or a prior one) is still
      // pending — not a failure, so surface the same "waiting for approval" state instead of
      // a retry-inviting error toast.
      if (e instanceof WorldApiError && e.code === 'ALREADY_REQUESTED') {
        core.familyJoinPending = true;
        core.toast('social.family.joinRequested', 'success');
      } else {
        core.toast('social.family.joinFail');
      }
    }
    core.render();
  }

  async doCreateSect(): Promise<void> {
    const core = this.core;
    const name = core.sectCreateName.trim();
    const tag = core.sectCreateTag.trim().toUpperCase();
    if (!name || !tag) return;
    core.clearHiddenInput();
    try {
      await core.cb.createSect?.(name, tag);
      core.toast('social.sect.created', 'success');
      core.sectSubview = 'info';
      core.sectCreateName = '';
      core.sectCreateTag = '';
      core.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      core.toast('social.sect.createFail');
    }
    core.render();
  }

  async doJoinSect(): Promise<void> {
    const core = this.core;
    const id = core.sectJoinId.trim();
    if (!id) return;
    core.clearHiddenInput();
    try {
      await core.cb.joinSect?.(id);
      core.toast('social.sect.joined', 'success');
      core.sectSubview = 'info';
      core.sectJoinId = '';
      core.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      core.toast('social.sect.joinFail');
    }
    core.render();
  }

  async doSendWorldChat(): Promise<void> {
    const core = this.core;
    const body = core.worldChatInput.trim();
    if (!body || core.worldSending || !core.cb.sendWorldChat) return;
    core.clearHiddenInput();
    core.worldSending = true;
    core.render();
    try {
      const senderName = core.cb.playerName?.() ?? '';
      await core.cb.sendWorldChat(body, senderName);
      core.worldChatInput = '';
      core.worldStick = true; // snap to the just-posted message when the re-fetch lands
      core.toast('social.world.sent', 'success');
      // Re-sync coins so the HUD reflects the server-side deduction (see refreshWallet doc).
      await core.cb.refreshWallet?.();
      void this.loadWorldMessages();
    } catch {
      core.toast('social.world.sendFail');
    } finally {
      core.worldSending = false;
    }
    core.render();
  }

  async doClaim(m: MailView): Promise<void> {
    const core = this.core;
    try {
      const ok = await core.cb.claimMail(m.mailId);
      if (ok) { m.claimed = true; core.toast('mail.claimDone', 'success'); }
      else core.toast('mail.claimFail');
    } catch (e) {
      core.toast(((e as { code?: string } | null)?.code) === 'ALREADY_CLAIMED' ? 'mail.alreadyClaimed' : 'mail.claimFail');
    }
    core.render();
    void this.refresh();
  }

  async doMailDelete(m: MailView): Promise<void> {
    const core = this.core;
    try {
      await core.cb.deleteMail(m.mailId);
      core.openMailItem = null;
    } catch (e) {
      core.toast(((e as { code?: string } | null)?.code) === 'MAIL_HAS_UNCLAIMED_ATTACHMENT'
        ? 'mail.deleteBlockedAttachment' : 'friends.error');
    }
    core.render();
    void this.refresh();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Cheap change-detector over everything refresh() writes onto core — see the repaint skip in
 * refresh()'s finally. Covers exactly the fields the friends/mail panels and the tab-rail badges
 * read, so a signature match means no visible difference; anything cheaper than a full tree rebuild
 * is worth it here, and this runs once per refresh rather than per row.
 */
function refreshSignature(core: FriendsSceneCore): string {
  return [
    core.friends.map((f) => `${f.publicId}|${f.online ? 1 : 0}|${f.alias ?? ''}|${f.displayName}|${f.rank ?? ''}|${f.avatarId ?? ''}`).join(','),
    core.incoming.map((r) => `${r.requestId}|${r.fromName}`).join(','),
    core.mail.map((m) => `${m.mailId}|${m.read ? 1 : 0}|${m.claimed ? 1 : 0}`).join(','),
    String(core.mailUnread),
    core.conversations.map((c) => `${c.peer.publicId}|${c.unread}`).join(','),
  ].join('¦');
}

function addErrorKey(e: unknown): TranslationKey {
  const code = (e as { code?: string } | null)?.code;
  switch (code) {
    case 'ALREADY_FRIEND':      return 'friends.alreadyFriend';
    case 'FRIEND_CAP_REACHED':  return 'friends.capReached';
    case 'BLOCKED':             return 'friends.blocked';
    case 'NOT_FOUND':           return 'friends.notFound';
    default:                    return 'friends.error';
  }
}
