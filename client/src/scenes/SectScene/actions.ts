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
import { EMBLEM_KEYS, EMBLEM_COLORS, loadEmblemAtlas, type EmblemKey } from '../../render/emblemIcon';
import { drawEmblemPickerDialog, type EmblemPickerState } from '../../ui/dialogs/emblemPickerDialog';
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
  openEmblemPicker(): void;
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
    if (core.hiddenInput) { core.hiddenInput.close(); core.hiddenInput = null; }
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

  /** In-progress pick for the emblem-picker modal (see emblemPickerDialog.ts) — reset each time the modal opens. */
  private pendingEmblem: EmblemPickerState = { key: EMBLEM_KEYS[0], color: EMBLEM_COLORS[0] };

  /** Sect-leader-only (family-emblem-art-prompts.md, 2026-08-14): opens the shared emblem-picker
   *  modal seeded with the sect's current badge (or the first key/colour if none chosen yet). */
  openEmblemPicker(): void {
    const core = this.core;
    if (!core.sect || !core.isSectLeader) return;
    this.pendingEmblem = {
      key: (core.sect.emblemKey as EmblemKey | undefined) ?? EMBLEM_KEYS[0],
      color: core.sect.emblemColor ?? EMBLEM_COLORS[0],
    };
    core.modalOpen = true;
    // Atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts) — the dialog draws a tinted
    // placeholder per cell until this resolves, then redraws with the real icons.
    void loadEmblemAtlas().then(() => { if (core.modalOpen) this.redrawEmblemPicker(); }).catch(() => { /* placeholder stays */ });
    this.redrawEmblemPicker();
  }

  /** Redraws the emblem-picker modal in place — called after every tap (pick icon/colour) and while
   *  the confirm POST is in flight (mirrors FamilyScene/actions.ts's identical pattern). */
  private redrawEmblemPicker(): void {
    const core = this.core;
    core.modalHits = drawEmblemPickerDialog(
      core.modalLayer, core.w, core.h, this.pendingEmblem, core.bt.busy,
      (key) => { this.pendingEmblem = { ...this.pendingEmblem, key }; this.redrawEmblemPicker(); },
      (color) => { this.pendingEmblem = { ...this.pendingEmblem, color }; this.redrawEmblemPicker(); },
      () => void this.doSetEmblem(),
      () => core.closeModal(),
    );
  }

  private async doSetEmblem(): Promise<void> {
    const core = this.core;
    if (core.bt.busy || !core.sect) return;
    core.bt.start();
    this.redrawEmblemPicker();
    try {
      const { key, color } = this.pendingEmblem;
      await withTimeout(core.cb.worldApi.setSectEmblem(core.cb.worldId, key, color));
      core.sect = { ...core.sect, emblemKey: key, emblemColor: color };
      core.closeModal();
      core.showToast(t('sect.emblemUpdated'), C.dark);
      core.render(); // header/summary-row badge needs the fresh sect object
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      if (core.modalOpen) this.redrawEmblemPicker();
    }
  }
}
