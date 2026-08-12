// Defense config (C3 editor) + attack formation team templates (G3-2c).
import type { WorldApiCore } from './core';
import type { DefenseConfig, TeamTemplate } from './types';

/** Defense/teams domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class DefenseTeamsService {
  constructor(private readonly core: WorldApiCore) {}

  /** Read the current defense config (pre-filled by the C3 editor). tileKey='base' for the main city or '{x}:{y}' for a territory tile; returns null if not set. */
  async getDefense(worldId: string, tileKey: string): Promise<DefenseConfig | null> {
    return this.core.req(
      'GET',
      `/world/defense?worldId=${encodeURIComponent(worldId)}&tileKey=${encodeURIComponent(tileKey)}`
    );
  }

  /** Set or update the defense config. tileKey='base' for the main city or '{x}:{y}' for a territory tile. */
  async setDefense(
    worldId: string,
    tileKey: string,
    defenseConfig: DefenseConfig
  ): Promise<{ ok: true }> {
    return this.core.req('PUT', '/world/defense', { worldId, tileKey, defenseConfig });
  }

  /** Read the attack formation template list (pre-fills the team editor / march team selector). */
  async getTeams(worldId: string): Promise<TeamTemplate[]> {
    return this.core.req('GET', `/world/teams?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Overwrite attack formation templates (pass the full set at once, max 5 teams). */
  async setTeams(worldId: string, teams: TeamTemplate[]): Promise<{ ok: true }> {
    return this.core.req('PUT', '/world/teams', { worldId, teams });
  }
}
