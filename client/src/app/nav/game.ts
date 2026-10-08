// Campaign / battle / growth navigation: local PvP-vs-AI, campaign map + level prep + campaign match,
// collection, card roster, equipment, stats, leaderboard, achievements, titles, tutorial.
// Split into form① factories (2026-08-12, see claudedocs/client-modules.md):
// - game/campaignRoster.ts: goGame/goCampaignMap/goLevelPrep/goCardRoster/goEquipment/goCampaign
//   (campaign and roster stay together — a real two-way call dependency between them, see that file's header)
// - game/career.ts: goStats/goLeaderboard/goAchievements/goTitles/goCodex (self-contained peer-tab group)
// - game/tutorial.ts: goTutorial + its graduation hand-off into the first campaign level (2026-10-07)
// This file just assembles them into the single createGameNav(ctx) factory surface.
import type { AppCtx, Nav } from '../appCtx';
import { createCampaignRosterNav } from './game/campaignRoster';
import { createCareerNav } from './game/career';
import { createTutorialNav } from './game/tutorial';

type GameNav = Pick<Nav,
  'goGame' | 'goCampaignMap' | 'goLevelPrep' | 'goCardRoster' | 'goEquipment' |
  'goStats' | 'goLeaderboard' | 'goAchievements' | 'goCampaign' | 'goTutorial' | 'goTitles' | 'goCodex'>;

export function createGameNav(ctx: AppCtx): GameNav {
  return { ...createCampaignRosterNav(ctx), ...createCareerNav(ctx), ...createTutorialNav(ctx) };
}
