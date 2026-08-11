// Data loading + live-message ingestion: family/sect membership resolution, sect detail + channel
// fetch, and the gateway-push handler that keeps the channel in sync.
//
// DataPanel has no dependency on any other domain class — Actions depends on IT (2026-08-11
// converted from the former `XMixin(Base)` inheritance chain to an independent class over `core`,
// per claudedocs/client-modules.md's split-form priority note).
import type { SectMessageView } from '../../net/WorldApiClient';
import type { SectSceneCore } from './core';

export interface DataHandlers {
  loadData(): Promise<void>;
  loadMySect(sectId: string): Promise<void>;
  loadChannel(): Promise<void>;
  applySectMsg(msg: SectMessageView): void;
}

export class DataPanel implements DataHandlers {
  constructor(private readonly core: SectSceneCore) {}

  async loadData(): Promise<void> {
    const core = this.core;
    if (core.destroyed) return;
    try {
      // Family membership lives in socialsvc; worldsvc's playerWorld.familyId is a
      // join-time-only mirror that never reflects a family created/joined afterward.
      const fam = await core.cb.worldApi.getMyFamily();
      if (!fam) {
        core.inFamily = false;
        core.mode = 'noSect';
      } else {
        core.inFamily = true;
        core.myFamilyId = fam.familyId;
        core.myFamilyRole = fam.members?.find(m => m.accountId === core.cb.myAccountId)?.role ?? 'member';
        if (fam.sectId) {
          await this.loadMySect(fam.sectId);
        } else {
          core.mode = 'noSect';
        }
      }
    } catch {
      core.mode = 'noSect';
    }
    if (!core.destroyed) core.render();
  }

  async loadMySect(sectId: string): Promise<void> {
    const core = this.core;
    const sect = await core.cb.worldApi.getSect(sectId);
    core.sect = sect;
    core.mode = 'mySect';
    await this.loadChannel();
  }

  async loadChannel(): Promise<void> {
    const core = this.core;
    if (!core.sect) return;
    core.messages = await core.cb.worldApi.getSectChannel(core.cb.worldId);
  }

  /**
   * Received a real-time sect channel message (gateway push, S8-4b) → deduplicate, insert, and re-render if needed.
   * messages are newest-first (consistent with getSectChannel), so new messages are unshifted to the front.
   */
  applySectMsg(msg: SectMessageView): void {
    const core = this.core;
    if (core.destroyed) return;
    if (core.messages.some((m) => m.ts === msg.ts && m.senderId === msg.senderId && m.body === msg.body)) {
      return; // deduplicate with polling / resend
    }
    core.messages.unshift(msg);
    // Landscape shows the channel column permanently (split view), so re-render regardless of
    // the active tab; portrait only needs it while the channel tab is showing.
    if (core.mode === 'mySect' && (core.landscape || core.activeTab === 'channel')) core.render();
  }
}
