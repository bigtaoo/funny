// Troops training queue (S8-2) + city building upgrades (SLG_CITY_DESIGN P1) + CC-4 troop
// distribution and card recovery.
import type { WorldApiCore } from './core';
import type { PlayerWorldView, BuildingKey } from './types';

/** Training/building/CC-4 domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class CityOpsService {
  constructor(private readonly core: WorldApiCore) {}

  /** Queue troop training (consumes ink + time). Returns the updated player state. */
  async trainTroops(worldId: string, qty: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/troops/train', { worldId, qty });
  }

  /** Speed up training with coins (deducted via the commercial service). */
  async speedupTraining(worldId: string, coins: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/troops/speedup', { worldId, coins });
  }

  async upgradeBuilding(worldId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/build/upgrade', { worldId, key });
  }

  async speedupBuild(worldId: string, key: BuildingKey, coins: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/build/speedup', { worldId, key, coins });
  }

  /**
   * Distribute troops from the base troop stock to card slots (CC-4, CHARACTER_CARDS_DESIGN §6.5).
   * allocations: cardInstanceId → troops to add. Server validates stock + troopCap per card.
   */
  async distributeTroops(
    worldId: string,
    allocations: Record<string, number>
  ): Promise<{ ok: true }> {
    return this.core.req('POST', '/world/troops/distribute', { worldId, allocations });
  }

  /**
   * Spend coins to immediately recover an injured card (CC-4, CHARACTER_CARDS_DESIGN §7.2).
   * Clears injuredUntil for the card; unlocks the team if no remaining injuries.
   * Insufficient coins → WorldApiError('INSUFFICIENT_FUNDS').
   */
  async recoverCard(worldId: string, cardInstanceId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/world/troops/recover', { worldId, cardInstanceId });
  }
}
