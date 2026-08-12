// Nations (nation system S8-6.5) + season (S8-7).
import type { WorldApiCore } from './core';
import type { NationView, SeasonView } from './types';

/** Nations/season domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class NationsSeasonService {
  constructor(private readonly core: WorldApiCore) {}

  async getNations(worldId: string): Promise<NationView[]> {
    return this.core.req('GET', `/world/nations?worldId=${encodeURIComponent(worldId)}`);
  }

  async setNationName(worldId: string, capitalIdx: number, name: string): Promise<{ ok: true }> {
    return this.core.req('POST', `/world/nations/${capitalIdx}/name`, { worldId, name });
  }

  async getSeason(worldId: string): Promise<SeasonView> {
    return this.core.req('GET', `/world/season?worldId=${encodeURIComponent(worldId)}`);
  }
}
