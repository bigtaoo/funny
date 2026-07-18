// Networking: all async API/callback methods (refresh + SLG/world loads + friend/family/sect/world/mail actions).
// Every body just calls the injected callbacks (this.cb.*) and updates base state + re-renders.
import { TranslationKey } from '../../i18n';
import { type Constructor, type FriendsSceneBaseCtor } from './base';
import type { MailView } from '../../net/ApiClient';

export interface NetworkHandlers {
  refresh(): Promise<void>;
  loadSLGStatus(): Promise<void>;
  loadWorldMessages(): Promise<void>;
  doSearch(): Promise<void>;
  doAdd(publicId: string): Promise<void>;
  doRespond(requestId: string, accept: boolean): Promise<void>;
  doRemove(publicId: string): Promise<void>;
  doBlock(publicId: string): Promise<void>;
  doCreateFamily(): Promise<void>;
  loadFamilyBrowse(query: string): Promise<void>;
  doJoinFamily(familyId: string): Promise<void>;
  doCreateSect(): Promise<void>;
  doJoinSect(): Promise<void>;
  doSendWorldChat(): Promise<void>;
  doClaim(m: MailView): Promise<void>;
  doMailDelete(m: MailView): Promise<void>;
}

export function NetworkMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<NetworkHandlers> {
  return class extends Base {
    // ── Data ───────────────────────────────────────────────────────────────────

    async refresh(): Promise<void> {
      try {
        const [friends, requests, mail] = await Promise.all([
          this.cb.loadFriends(),
          this.cb.loadRequests(),
          this.cb.loadMail(),
        ]);
        this.friends = friends;
        this.incoming = requests.incoming;
        this.mail = mail.mail;
        this.mailUnread = mail.unread;
      } catch {
        if (this.loading) this.toast('friends.error');
      } finally {
        this.loading = false;
        if (!this.dead) this.render();
      }
    }

    async loadSLGStatus(): Promise<void> {
      if (!this.cb.loadSLGStatus || this.slgLoading) return;
      this.slgLoading = true;
      this.render();
      try {
        this.slgStatus = await this.cb.loadSLGStatus();
      } catch {
        this.slgStatus = null;
      } finally {
        this.slgLoading = false;
        this.slgLoaded = true;
        if (!this.dead) this.render();
      }
    }

    async loadWorldMessages(): Promise<void> {
      if (!this.cb.loadWorldChat || this.worldLoading) return;
      this.worldLoading = true;
      this.worldLoadError = false;
      if (!this.dead) this.render();
      try {
        const msgs = await this.cb.loadWorldChat();
        this.worldMessages = msgs.slice().reverse(); // server newest-first → oldest-first for display
        this.worldLoaded = true;
      } catch {
        this.worldLoadError = true;
      } finally {
        this.worldLoading = false;
      }
      if (!this.dead) this.render();
    }

    async doSearch(): Promise<void> {
      if (this.searchDigits.length === 0) return;
      const id = this.searchDigits.join('');
      this.searchResult = null;
      this.searchMsgKey = 'friends.searching';
      this.render();
      try {
        this.searchResult = await this.cb.search(id);
        this.searchMsgKey = null;
      } catch {
        this.searchResult = null;
        this.searchMsgKey = 'friends.notFound';
      }
      this.render();
    }

    async doAdd(publicId: string): Promise<void> {
      try {
        await this.cb.addFriend(publicId);
        this.toast('friends.requestSent', 'success');
        this.view = 'list';
        this.render();
        void this.refresh();
      } catch (e) {
        this.toast(addErrorKey(e));
        this.render();
      }
    }

    async doRespond(requestId: string, accept: boolean): Promise<void> {
      try { await this.cb.respond(requestId, accept); } catch { this.toast('friends.error'); }
      void this.refresh();
    }

    async doRemove(publicId: string): Promise<void> {
      this.popup.hide();
      try { await this.cb.removeFriend(publicId); this.toast('friends.removed', 'success'); } catch { this.toast('friends.error'); }
      void this.refresh();
    }

    async doBlock(publicId: string): Promise<void> {
      try { await this.cb.blockUser(publicId); this.toast('friends.blockedDone', 'success'); } catch { this.toast('friends.error'); }
      void this.refresh();
    }

    async doCreateFamily(): Promise<void> {
      const name = this.familyCreateName.trim();
      const tag = this.familyCreateTag.trim().toUpperCase();
      if (!name || !tag) return;
      this.clearHiddenInput();
      try {
        await this.cb.createFamily?.(name, tag);
        this.toast('social.family.created', 'success');
        this.familySubview = 'info';
        this.familyCreateName = '';
        this.familyCreateTag = '';
        this.slgLoaded = false;
        void this.loadSLGStatus();
      } catch {
        this.toast('social.family.createFail');
      }
      this.render();
    }

    async loadFamilyBrowse(query: string): Promise<void> {
      this.familyBrowseLoading = true;
      this.render();
      try {
        this.familyBrowseResults = await this.cb.browseFamilies?.(query) ?? [];
      } catch {
        this.familyBrowseResults = [];
      } finally {
        this.familyBrowseLoading = false;
        this.familyBrowseLoaded = true;
      }
      if (!this.dead) this.render();
    }

    async doJoinFamily(familyId: string): Promise<void> {
      if (!familyId) return;
      this.clearHiddenInput();
      try {
        await this.cb.joinFamily?.(familyId);
        this.toast('social.family.joined', 'success');
        this.familySubview = 'info';
        this.familyBrowseQuery = '';
        this.familyBrowseResults = [];
        this.familyBrowseLoaded = false;
        this.familyDetailView = null;
        this.slgLoaded = false;
        void this.loadSLGStatus();
      } catch {
        this.toast('social.family.joinFail');
      }
      this.render();
    }

    async doCreateSect(): Promise<void> {
      const name = this.sectCreateName.trim();
      const tag = this.sectCreateTag.trim().toUpperCase();
      if (!name || !tag) return;
      this.clearHiddenInput();
      try {
        await this.cb.createSect?.(name, tag);
        this.toast('social.sect.created', 'success');
        this.sectSubview = 'info';
        this.sectCreateName = '';
        this.sectCreateTag = '';
        this.slgLoaded = false;
        void this.loadSLGStatus();
      } catch {
        this.toast('social.sect.createFail');
      }
      this.render();
    }

    async doJoinSect(): Promise<void> {
      const id = this.sectJoinId.trim();
      if (!id) return;
      this.clearHiddenInput();
      try {
        await this.cb.joinSect?.(id);
        this.toast('social.sect.joined', 'success');
        this.sectSubview = 'info';
        this.sectJoinId = '';
        this.slgLoaded = false;
        void this.loadSLGStatus();
      } catch {
        this.toast('social.sect.joinFail');
      }
      this.render();
    }

    async doSendWorldChat(): Promise<void> {
      const body = this.worldChatInput.trim();
      if (!body || this.worldSending || !this.cb.sendWorldChat) return;
      this.clearHiddenInput();
      this.worldSending = true;
      this.render();
      try {
        const senderName = this.cb.playerName?.() ?? '';
        await this.cb.sendWorldChat(body, senderName);
        this.worldChatInput = '';
        this.toast('social.world.sent', 'success');
        // Re-sync coins so the HUD reflects the server-side deduction (see refreshWallet doc).
        await this.cb.refreshWallet?.();
        void this.loadWorldMessages();
      } catch {
        this.toast('social.world.sendFail');
      } finally {
        this.worldSending = false;
      }
      this.render();
    }

    async doClaim(m: MailView): Promise<void> {
      try {
        const ok = await this.cb.claimMail(m.mailId);
        if (ok) { m.claimed = true; this.toast('mail.claimDone', 'success'); }
        else this.toast('mail.claimFail');
      } catch (e) {
        this.toast(((e as { code?: string } | null)?.code) === 'ALREADY_CLAIMED' ? 'mail.alreadyClaimed' : 'mail.claimFail');
      }
      this.render();
      void this.refresh();
    }

    async doMailDelete(m: MailView): Promise<void> {
      try {
        await this.cb.deleteMail(m.mailId);
        this.openMailItem = null;
      } catch (e) {
        this.toast(((e as { code?: string } | null)?.code) === 'MAIL_HAS_UNCLAIMED_ATTACHMENT'
          ? 'mail.deleteBlockedAttachment' : 'friends.error');
      }
      this.render();
      void this.refresh();
    }
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────

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
