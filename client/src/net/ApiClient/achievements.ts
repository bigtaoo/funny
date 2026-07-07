// Achievements (S9-5, requires login token). Tier computation is done locally on the client.
import type { SaveData } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { AchievementsView } from './types';

export interface AchievementsApi {
  getAchievements(): Promise<AchievementsView>;
  claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }>;
}

export function AchievementsMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<AchievementsApi> {
  return class extends Base {
    // ── Achievements (S9-5, requires login token) ────────────────────────────
    /** Achievement definition table + my stats + claimed progress; tier computation is done locally on the client (ACHIEVEMENT_DESIGN §6). */
    async getAchievements(): Promise<AchievementsView> {
      return this.request<AchievementsView>('GET', '/achievements');
    }

    /** Claim coins for an achievement tier: server re-validates stat≥threshold + idempotent coin grant → pushes back authoritative save + amount granted this call. */
    async claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }> {
      return this.post<{ save: SaveData; granted: number }>('/achievements/claim', { achId, tier });
    }
  };
}
