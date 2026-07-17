// Data loading + live-message ingestion: family/sect membership resolution, sect detail + channel
// fetch, and the gateway-push handler that keeps the channel in sync.
import type { SectMessageView } from '../../net/WorldApiClient';
import { type Constructor, type SectSceneBaseCtor } from './base';

export interface DataHandlers {
  loadData(): Promise<void>;
  loadMySect(sectId: string): Promise<void>;
  loadChannel(): Promise<void>;
  applySectMsg(msg: SectMessageView): void;
}

export function DataMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<DataHandlers> {
  return class extends Base {
    async loadData(): Promise<void> {
      if (this.destroyed) return;
      try {
        // Family membership lives in socialsvc; worldsvc's playerWorld.familyId is a
        // join-time-only mirror that never reflects a family created/joined afterward.
        const fam = await this.cb.worldApi.getMyFamily();
        if (!fam) {
          this.inFamily = false;
          this.mode = 'noSect';
        } else {
          this.inFamily = true;
          this.myFamilyId = fam.familyId;
          this.myFamilyRole = fam.members?.find(m => m.accountId === this.cb.myAccountId)?.role ?? 'member';
          if (fam.sectId) {
            await this.loadMySect(fam.sectId);
          } else {
            this.mode = 'noSect';
          }
        }
      } catch {
        this.mode = 'noSect';
      }
      if (!this.destroyed) this.render();
    }

    async loadMySect(sectId: string): Promise<void> {
      const sect = await this.cb.worldApi.getSect(sectId);
      this.sect = sect;
      this.mode = 'mySect';
      await this.loadChannel();
    }

    async loadChannel(): Promise<void> {
      if (!this.sect) return;
      this.messages = await this.cb.worldApi.getSectChannel(this.cb.worldId);
    }

    /**
     * Received a real-time sect channel message (gateway push, S8-4b) → deduplicate, insert, and re-render if needed.
     * messages are newest-first (consistent with getSectChannel), so new messages are unshifted to the front.
     */
    applySectMsg(msg: SectMessageView): void {
      if (this.destroyed) return;
      if (this.messages.some((m) => m.ts === msg.ts && m.senderId === msg.senderId && m.body === msg.body)) {
        return; // deduplicate with polling / resend
      }
      this.messages.unshift(msg);
      // Landscape shows the channel column permanently (split view), so re-render regardless of
      // the active tab; portrait only needs it while the channel tab is showing.
      if (this.mode === 'mySect' && (this.landscape || this.activeTab === 'channel')) this.render();
    }
  };
}
