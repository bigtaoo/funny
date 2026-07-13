// Data loading for the family scene: fetch membership, family detail, and channel messages.
import type { FamilyDetailView } from '../../net/WorldApiClient';
import { type Constructor, type FamilySceneBaseCtor } from './base';

export interface DataHandlers {
  loadData(): Promise<void>;
  loadMyFamily(familyId: string): Promise<void>;
  loadChannel(): Promise<void>;
}

export function DataMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<DataHandlers> {
  return class extends Base {
    async loadData(): Promise<void> {
      if (this.destroyed) return;
      try {
        // Family membership lives in socialsvc; worldsvc's playerWorld.familyId is a
        // join-time-only mirror that never reflects a family created/joined afterward.
        const fam = await this.cb.worldApi.getMyFamily();
        if (fam) {
          await this.applyFamily(fam);
        } else {
          this.mode = 'noFamily';
        }
      } catch {
        this.mode = 'noFamily';
      }
      if (!this.destroyed) this.render();
    }

    async loadMyFamily(familyId: string): Promise<void> {
      const fam = await this.cb.worldApi.getFamily(familyId);
      await this.applyFamily(fam);
    }

    private async applyFamily(fam: FamilyDetailView): Promise<void> {
      this.family = fam;
      this.members = fam.members ?? [];
      this.mode = 'myFamily';
      await this.loadChannel();
    }

    async loadChannel(): Promise<void> {
      if (!this.family) return;
      const ch = await this.cb.worldApi.getFamilyChannel(this.family.familyId);
      this.messages = ch;
    }
  };
}
