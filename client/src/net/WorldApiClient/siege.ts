// Siege replay (spectator replay, G3-2c).
import type { WorldApiCore } from './core';
import type { SiegeReplayView, SiegeSummaryView } from './types';

/** Siege-replay domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class SiegeService {
  constructor(private readonly core: WorldApiCore) {}

  /**
   * Fetch the replay level for a key siege (seed + LevelDefinition reconstructed from both armies). Readable by both attacker and defender.
   * Client uses the returned seed to headlessly re-run in siege mode with an empty ReplayInputSource → exact byte-for-byte reproduction.
   */
  async getSiegeReplay(worldId: string, siegeId: string): Promise<SiegeReplayView> {
    return this.core.req(
      'GET',
      `/world/siege/${encodeURIComponent(siegeId)}/replay?worldId=${encodeURIComponent(worldId)}`
    );
  }

  /** Recent siege battle reports (attacker or defender), newest first — backing the last-100 replay browser. */
  async listSieges(worldId: string, limit = 100): Promise<SiegeSummaryView[]> {
    return this.core.req(
      'GET',
      `/world/sieges?worldId=${encodeURIComponent(worldId)}&limit=${limit}`
    );
  }
}
