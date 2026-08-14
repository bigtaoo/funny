// Data loading for the family scene: fetch membership, family detail, and channel messages.
//
// DataPanel has no dependency on any other domain class — Actions and Input both depend on IT
// (2026-08-11 converted from the former `XMixin(Base)` inheritance chain to an independent class
// over `core`, per claudedocs/client-modules.md's split-form priority note).
import type { FamilyDetailView, FamilyMessageView } from '../../net/WorldApiClient';
import { loadEmblemAtlas } from '../../render/emblemIcon';
import type { FamilySceneCore } from './core';

export interface DataHandlers {
  loadData(): Promise<void>;
  loadMyFamily(familyId: string): Promise<void>;
  loadChannel(): Promise<void>;
  loadJoinRequests(): Promise<void>;
  applyFamilyMsg(msg: FamilyMessageView): void;
}

export class DataPanel implements DataHandlers {
  constructor(private readonly core: FamilySceneCore) {}

  async loadData(): Promise<void> {
    const core = this.core;
    if (core.destroyed) return;
    // Best-effort, independent of the family fetch below — only gates the member-profile
    // popup's "Add Friend" action, so a failure here shouldn't block showing the roster.
    void core.cb.getFriendPublicIds().then((ids) => {
      if (!core.destroyed) core.friendPublicIds = ids;
    }).catch(() => { /* keep the empty default */ });
    try {
      // Family membership lives in socialsvc; worldsvc's playerWorld.familyId is a
      // join-time-only mirror that never reflects a family created/joined afterward.
      const fam = await core.cb.worldApi.getMyFamily();
      if (fam) {
        await this.applyFamily(fam);
      } else {
        core.mode = 'noFamily';
      }
    } catch {
      core.mode = 'noFamily';
    }
    if (!core.destroyed) core.render();
  }

  async loadMyFamily(familyId: string): Promise<void> {
    const core = this.core;
    const fam = await core.cb.worldApi.getFamily(familyId);
    await this.applyFamily(fam);
  }

  private async applyFamily(fam: FamilyDetailView): Promise<void> {
    const core = this.core;
    core.family = fam;
    core.members = fam.members ?? [];
    core.mode = 'myFamily';
    // Paint the roster/identity as soon as the family is known — the channel is a second
    // round-trip, so don't hold the whole scene blank on it. loadData()/doJoin() render again
    // once loadChannel() lands, filling the message list in.
    if (!core.destroyed) core.render();
    // Emblem atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts); kick it off as soon as we
    // know the family (which may already have a badge picked), re-rendering once it resolves so
    // the header/info-band badge (drawHeaderTitle / renderInfoBand) doesn't stay blank until the
    // player happens to open the picker. Idempotent — a no-op if already loaded/loading.
    if (fam.emblemKey) void loadEmblemAtlas().then(() => { if (!core.destroyed) core.render(); }).catch(() => {});
    await this.loadChannel();
    await this.loadJoinRequests();
  }

  async loadChannel(): Promise<void> {
    const core = this.core;
    if (!core.family) return;
    const ch = await core.cb.worldApi.getFamilyChannel(core.family.familyId);
    core.messages = ch;
  }

  async loadJoinRequests(): Promise<void> {
    const core = this.core;
    if (!core.family || !core.isFamilyApprover) { core.joinRequests = []; return; }
    try {
      core.joinRequests = await core.cb.worldApi.listJoinRequests();
    } catch {
      core.joinRequests = [];
    }
    if (!core.destroyed) core.render();
  }

  /**
   * Received a real-time family channel message (gateway push, socialsvc → gateway) → deduplicate,
   * insert, and re-render if needed. Mirrors SectScene's applySectMsg; messages are newest-first
   * (consistent with getFamilyChannel), so new messages are unshifted to the front.
   */
  applyFamilyMsg(msg: FamilyMessageView): void {
    const core = this.core;
    if (core.destroyed) return;
    if (core.messages.some((m) => m.ts === msg.ts && m.senderId === msg.senderId && m.body === msg.body)) {
      return; // deduplicate with polling / resend
    }
    core.messages.unshift(msg);
    // Landscape shows the channel column permanently (split view), so re-render regardless of
    // the active tab; portrait only needs it while the channel tab is showing.
    if (core.mode === 'myFamily' && (core.landscape || core.activeTab === 'channel')) core.render();
  }
}
