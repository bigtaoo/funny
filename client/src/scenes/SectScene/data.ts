// Data loading + live-message ingestion: family/sect membership resolution, sect detail + channel
// fetch, and the gateway-push handler that keeps the channel in sync.
//
// DataPanel has no dependency on any other domain class — Actions depends on IT (2026-08-11
// converted from the former `XMixin(Base)` inheritance chain to an independent class over `core`,
// per claudedocs/client-modules.md's split-form priority note).
import type { SectDetailView, SectMessageView } from '../../net/WorldApiClient';
import { loadEmblemAtlas } from '../../render/emblemIcon';
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
      // The social hub hands its own just-fetched copy over on the way in (preloadedFamily /
      // preloadedSect below) — see SectSceneCallbacks for why.
      const fam = core.cb.preloadedFamily ?? await core.cb.worldApi.getMyFamily();
      core.family = fam ?? null;
      if (!fam) {
        core.inFamily = false;
        core.mode = 'noSect';
      } else {
        core.inFamily = true;
        core.myFamilyId = fam.familyId;
        core.myFamilyRole = fam.members?.find(m => m.accountId === core.cb.myAccountId)?.role ?? 'member';
        if (fam.sectId) {
          // Only for THIS sect: a preload left over from a different sect (or a stale one from
          // before a join/leave) would paint the wrong roster.
          const pre = core.cb.preloadedSect;
          if (pre && pre.sectId === fam.sectId) await this.applySect(pre);
          else await this.loadMySect(fam.sectId);
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
    await this.applySect(await this.core.cb.worldApi.getSect(sectId));
  }

  /** Adopt a sect detail (freshly fetched or handed over by the hub) and pull its channel. */
  private async applySect(sect: SectDetailView): Promise<void> {
    const core = this.core;
    core.sect = sect;
    core.mode = 'mySect';
    core.cb.onSectLoaded?.(sect);
    // Paint the roster/identity as soon as the sect is known — the channel is a second round-trip,
    // so don't hold the whole page blank on it (mirrors FamilyScene/data.ts's applyFamily). The
    // caller renders again once loadChannel() lands, filling the message list in.
    if (!core.destroyed) core.render();
    // Emblem atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts); kick it off once we know the
    // sect's own badge or any member family's badge is set, re-rendering once it resolves so the
    // header/summary-row/family-list badges (header.ts / render.ts / lists.ts) don't stay blank.
    // Idempotent — a no-op if already loaded/loading.
    if (sect.emblemKey || sect.memberFamilies.some((f) => f.emblemKey)) {
      void loadEmblemAtlas().then(() => { if (!core.destroyed) core.render(); }).catch(() => {});
    }
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
