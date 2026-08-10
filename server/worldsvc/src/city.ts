// worldsvc home-city domain facade: training queue (S8-2) + buildings (SLG_CITY_DESIGN) + teams/cards
// (G3-2c / CC-3). Peeled out of the WorldService god-class (2026-07-03).
//
// Composed of three independent domain classes (2026-08-10 split, 独立类+组合 form, friendService.ts's
// sibling — the original single 682-line class had no shared private state beyond `core: WorldCore`
// all three domains already take by constructor injection and zero cross-domain calls, so it splits
// cleanly into: training queue, buildings, and teams/cards — see city/training.ts, city/buildings.ts,
// city/teams.ts. This class is a thin delegating facade so external callers (service.ts, this
// package's own tests) keep importing `CityService` from this one path with an unchanged public API
// and behavior.
import { WorldCore } from './core';
import type { BuildingKey } from '@nw/shared';
import type { TeamTemplate } from './db';
import type { PlayerWorldView } from './worldTypes';
import { CityTrainingService } from './city/training';
import { CityBuildingsService } from './city/buildings';
import { CityTeamsService } from './city/teams';

export class CityService {
  private readonly training: CityTrainingService;
  private readonly buildings: CityBuildingsService;
  private readonly teams: CityTeamsService;

  constructor(private readonly core: WorldCore) {
    this.training = new CityTrainingService(core);
    this.buildings = new CityBuildingsService(core);
    this.teams = new CityTeamsService(core);
  }

  // --- S8-2: training queue (city/training.ts) ---
  trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    return this.training.trainTroops(worldId, accountId, qty);
  }
  speedupTraining(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.training.speedupTraining(worldId, accountId, coins, clientPlatform);
  }
  processCompletedTraining(nowMs?: number): Promise<number> {
    return this.training.processCompletedTraining(nowMs);
  }

  // --- SLG home-city buildings, SLG_CITY_DESIGN P1 (city/buildings.ts) ---
  upgradeBuilding(worldId: string, accountId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.buildings.upgradeBuilding(worldId, accountId, key);
  }
  speedupBuild(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.buildings.speedupBuild(worldId, accountId, coins, clientPlatform);
  }
  processCompletedBuilds(nowMs?: number): Promise<number> {
    return this.buildings.processCompletedBuilds(nowMs);
  }

  // --- G3-2c: attack formation templates (teams) + CC-3 card troop pool (city/teams.ts) ---
  getTeams(worldId: string, accountId: string): Promise<TeamTemplate[]> {
    return this.teams.getTeams(worldId, accountId);
  }
  setTeams(worldId: string, accountId: string, teams: TeamTemplate[]): Promise<void> {
    return this.teams.setTeams(worldId, accountId, teams);
  }
  distributeTroops(worldId: string, accountId: string, allocations: Record<string, number>): Promise<void> {
    return this.teams.distributeTroops(worldId, accountId, allocations);
  }
  recoverCard(worldId: string, accountId: string, cardInstanceId: string, clientPlatform?: string): Promise<void> {
    return this.teams.recoverCard(worldId, accountId, cardInstanceId, clientPlatform);
  }
}
