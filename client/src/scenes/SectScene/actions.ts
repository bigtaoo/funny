// Network actions + their confirm dialogs: create / browse-join, leave, dissolve, remove-leader vote,
// and ally / unally management. Each mutation calls the world API, refreshes state, and re-renders.
//
// ActionsPanel depends on DataPanel (via the narrow DataHandlers interface — loadMySect/loadChannel)
// and ModalsPanel (via ModalsHandlers — showSectPickModal/showConfirm), but neither depends back on
// Actions: one-way, so a plain independent class over `core` + `data` + `modals` (2026-08-11
// converted from the former `XMixin(Base)` inheritance chain, per claudedocs/client-modules.md's
// split-form priority note). RenderPanel and InputPanel depend on Actions in turn.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import type { SectView } from '../../net/WorldApiClient';
import { withTimeout } from '../../ui/busyTracker';
import type { SectSceneCore } from './core';
import type { DataHandlers } from './data';
import type { ModalsHandlers } from './modals';

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

export class ActionsPanel implements ActionsHandlers {
  constructor(
    private readonly core: SectSceneCore,
    private readonly data: DataHandlers,
    private readonly modals: ModalsHandlers
  ) {}

  async doCreate(): Promise<void> {
    const core = this.core;
    if (!core.createName.trim() || !core.createTag.trim()) {
      core.showToast(t('sect.err.badReq'), C.red); return;
    }
    if (core.bt.busy) return;
    core.bt.start();
    core.render();
    try {
      core.sect = await withTimeout(core.cb.worldApi.createSect(core.cb.worldId, core.createName.trim(), core.createTag.trim()));
      core.messages = [];
      core.mode = 'mySect';
      core.activeTab = 'families';
      core.render();
      // SECT_CREATE_COST was spent server-side (commercial service, off the createSect
      // response) — pull the deducted balance back into the local wallet cache.
      await core.cb.refreshWallet();
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async openBrowseList(): Promise<void> {
    const core = this.core;
    try {
      core.sectsCache = await core.cb.worldApi.listSects(core.cb.worldId);
      this.modals.showSectPickModal(core.sectsCache, (sid) => void this.doJoin(sid), 'sect.noSects');
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  async doJoin(sectId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.joinSect(core.cb.worldId, sectId));
      await this.data.loadMySect(sectId);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmLeave(): void {
    this.modals.showConfirm(t('sect.confirmLeave'), () => void this.doLeave());
  }

  async doLeave(): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.leaveSect(core.cb.worldId));
      core.sect = null; core.messages = [];
      core.mode = 'noSect';
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmDissolve(): void {
    this.modals.showConfirm(t('sect.confirmDissolve'), () => void this.doDissolve());
  }

  async doDissolve(): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.dissolveSect(core.cb.worldId));
      core.sect = null; core.messages = [];
      core.mode = 'noSect';
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmVote(nomineeFamilyId: string, nomineeLabel: string): void {
    this.modals.showConfirm(t('sect.confirmVote', { name: nomineeLabel }), () => void this.doVote(nomineeFamilyId));
  }

  async doVote(nomineeFamilyId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      const res = await withTimeout(core.cb.worldApi.voteRemoveSectLeader(core.cb.worldId, nomineeFamilyId));
      core.showToast(
        res.passed ? t('sect.votePassed') : t('sect.voteCounted', { cur: res.voteCount, need: res.needed }),
        res.passed ? C.accent : C.dark,
      );
      if (core.sect) await this.data.loadMySect(core.sect.sectId);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async openAllyList(): Promise<void> {
    const core = this.core;
    if (!core.sect) return;
    const sect = core.sect;
    try {
      core.sectsCache = await core.cb.worldApi.listSects(core.cb.worldId);
      const candidates = core.sectsCache.filter(
        s => s.sectId !== sect.sectId && !sect.allySectIds.includes(s.sectId),
      );
      this.modals.showSectPickModal(candidates, (sid) => {
        const target = candidates.find(s => s.sectId === sid);
        this.confirmAlly(sid, target ? `[${target.tag}] ${target.name}` : sid);
      }, 'sect.noSects');
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  /** Read-only current-allies list — open to every member (not just the leader) so regular
   *  members can see who the sect is allied with. No unally action (management is leader-only). */
  async openAlliesView(): Promise<void> {
    const core = this.core;
    if (!core.sect) return;
    const sect = core.sect;
    try {
      core.sectsCache = await core.cb.worldApi.listSects(core.cb.worldId);
      const allies = sect.allySectIds
        .map(id => core.sectsCache.find(s => s.sectId === id))
        .filter((s): s is SectView => !!s);
      this.modals.showSectPickModal(allies, () => {}, 'sect.noAllies', true);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  confirmAlly(targetSectId: string, label: string): void {
    this.modals.showConfirm(t('sect.confirmAlly', { name: label }), () => void this.doAlly(targetSectId));
  }

  async doAlly(targetSectId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.allySect(core.cb.worldId, targetSectId));
      if (core.sect) await this.data.loadMySect(core.sect.sectId);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async openManageAllies(): Promise<void> {
    const core = this.core;
    if (!core.sect) return;
    const sect = core.sect;
    try {
      // Resolve ally ids → names via the world sect list.
      core.sectsCache = await core.cb.worldApi.listSects(core.cb.worldId);
      const allies = sect.allySectIds
        .map(id => core.sectsCache.find(s => s.sectId === id))
        .filter((s): s is SectView => !!s);
      this.modals.showSectPickModal(allies, (sid) => {
        const target = allies.find(s => s.sectId === sid);
        this.confirmUnally(sid, target ? `[${target.tag}] ${target.name}` : sid);
      }, 'sect.noAllies');
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  confirmUnally(targetSectId: string, label: string): void {
    this.modals.showConfirm(t('sect.confirmUnally', { name: label }), () => void this.doUnally(targetSectId));
  }

  async doUnally(targetSectId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.unallySect(core.cb.worldId, targetSectId));
      if (core.sect) await this.data.loadMySect(core.sect.sectId);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async doSendChannelMessage(): Promise<void> {
    const core = this.core;
    const body = core.channelInput.trim();
    if (!body || core.channelSending || !core.sect) return;
    if (core.hiddenInput) { core.hiddenInput.remove(); core.hiddenInput = null; }
    core.channelActive = false;
    core.channelSending = true;
    core.channelStick = true; // sending always snaps to the newest line (renderChannel pins to bottom)
    core.render();
    try {
      await core.cb.worldApi.sendSectMessage(core.cb.worldId, body, core.cb.playerName);
      core.channelInput = '';
      await this.data.loadChannel();
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.channelSending = false;
      if (!core.destroyed) core.render();
    }
  }
}
