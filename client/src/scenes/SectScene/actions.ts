// Network actions + their confirm dialogs: create / browse-join, leave, dissolve, remove-leader vote,
// and ally / unally management. Each mutation calls the world API, refreshes state, and re-renders.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import type { SectView } from '../../net/WorldApiClient';
import { type Constructor, type SectSceneBaseCtor } from './base';

export interface ActionsHandlers {
  doCreate(): Promise<void>;
  openBrowseList(): Promise<void>;
  doJoin(sectId: string): Promise<void>;
  confirmLeave(): void;
  doLeave(): Promise<void>;
  confirmDissolve(): void;
  doDissolve(): Promise<void>;
  confirmVote(nomineeFamilyId: string, nomineeLabel: string): void;
  doVote(nomineeFamilyId: string): Promise<void>;
  openAllyList(): Promise<void>;
  openAlliesView(): Promise<void>;
  confirmAlly(targetSectId: string, label: string): void;
  doAlly(targetSectId: string): Promise<void>;
  openManageAllies(): Promise<void>;
  confirmUnally(targetSectId: string, label: string): void;
  doUnally(targetSectId: string): Promise<void>;
  doSendChannelMessage(): Promise<void>;
}

export function ActionsMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<ActionsHandlers> {
  return class extends Base {
    async doCreate(): Promise<void> {
      if (!this.createName.trim() || !this.createTag.trim()) {
        this.showToast(t('sect.err.badReq'), C.red); return;
      }
      try {
        this.sect = await this.cb.worldApi.createSect(this.cb.worldId, this.createName.trim(), this.createTag.trim());
        this.messages = [];
        this.mode = 'mySect';
        this.activeTab = 'families';
        this.render();
        // SECT_CREATE_COST was spent server-side (commercial service, off the createSect
        // response) — pull the deducted balance back into the local wallet cache.
        await this.cb.refreshWallet();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async openBrowseList(): Promise<void> {
      try {
        this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
        this.showSectPickModal(this.sectsCache, (sid) => void this.doJoin(sid), 'sect.noSects');
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async doJoin(sectId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.joinSect(this.cb.worldId, sectId);
        await this.loadMySect(sectId);
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmLeave(): void {
      this.showConfirm(t('sect.confirmLeave'), () => void this.doLeave());
    }

    async doLeave(): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.leaveSect(this.cb.worldId);
        this.sect = null; this.messages = [];
        this.mode = 'noSect';
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmDissolve(): void {
      this.showConfirm(t('sect.confirmDissolve'), () => void this.doDissolve());
    }

    async doDissolve(): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.dissolveSect(this.cb.worldId);
        this.sect = null; this.messages = [];
        this.mode = 'noSect';
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmVote(nomineeFamilyId: string, nomineeLabel: string): void {
      this.showConfirm(t('sect.confirmVote', { name: nomineeLabel }), () => void this.doVote(nomineeFamilyId));
    }

    async doVote(nomineeFamilyId: string): Promise<void> {
      this.closeModal();
      try {
        const res = await this.cb.worldApi.voteRemoveSectLeader(this.cb.worldId, nomineeFamilyId);
        this.showToast(
          res.passed ? t('sect.votePassed') : t('sect.voteCounted', { cur: res.voteCount, need: res.needed }),
          res.passed ? C.accent : C.dark,
        );
        if (this.sect) await this.loadMySect(this.sect.sectId);
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async openAllyList(): Promise<void> {
      if (!this.sect) return;
      const sect = this.sect;
      try {
        this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
        const candidates = this.sectsCache.filter(
          s => s.sectId !== sect.sectId && !sect.allySectIds.includes(s.sectId),
        );
        this.showSectPickModal(candidates, (sid) => {
          const target = candidates.find(s => s.sectId === sid);
          this.confirmAlly(sid, target ? `[${target.tag}] ${target.name}` : sid);
        }, 'sect.noSects');
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    /** Read-only current-allies list — open to every member (not just the leader) so regular
     *  members can see who the sect is allied with. No unally action (management is leader-only). */
    async openAlliesView(): Promise<void> {
      if (!this.sect) return;
      const sect = this.sect;
      try {
        this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
        const allies = sect.allySectIds
          .map(id => this.sectsCache.find(s => s.sectId === id))
          .filter((s): s is SectView => !!s);
        this.showSectPickModal(allies, () => {}, 'sect.noAllies', true);
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmAlly(targetSectId: string, label: string): void {
      this.showConfirm(t('sect.confirmAlly', { name: label }), () => void this.doAlly(targetSectId));
    }

    async doAlly(targetSectId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.allySect(this.cb.worldId, targetSectId);
        if (this.sect) await this.loadMySect(this.sect.sectId);
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async openManageAllies(): Promise<void> {
      if (!this.sect) return;
      const sect = this.sect;
      try {
        // Resolve ally ids → names via the world sect list.
        this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
        const allies = sect.allySectIds
          .map(id => this.sectsCache.find(s => s.sectId === id))
          .filter((s): s is SectView => !!s);
        this.showSectPickModal(allies, (sid) => {
          const target = allies.find(s => s.sectId === sid);
          this.confirmUnally(sid, target ? `[${target.tag}] ${target.name}` : sid);
        }, 'sect.noAllies');
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmUnally(targetSectId: string, label: string): void {
      this.showConfirm(t('sect.confirmUnally', { name: label }), () => void this.doUnally(targetSectId));
    }

    async doUnally(targetSectId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.unallySect(this.cb.worldId, targetSectId);
        if (this.sect) await this.loadMySect(this.sect.sectId);
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async doSendChannelMessage(): Promise<void> {
      const body = this.channelInput.trim();
      if (!body || this.channelSending || !this.sect) return;
      if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
      this.channelActive = false;
      this.channelSending = true;
      this.channelStick = true; // sending always snaps to the newest line (renderChannel pins to bottom)
      this.render();
      try {
        await this.cb.worldApi.sendSectMessage(this.cb.worldId, body, this.cb.playerName);
        this.channelInput = '';
        await this.loadChannel();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      } finally {
        this.channelSending = false;
        if (!this.destroyed) this.render();
      }
    }
  };
}
