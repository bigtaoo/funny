// Live-ops progression: achievements (S9), retention check-in / daily tasks (B5), limited-time events
// (B6), and player titles (S10). Counts are written only at authoritative settlement points elsewhere;
// these handlers read definitions/progress and deliver one-time coin/title claims.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): holds `core: MetaCore` — assembled by composition in ../service.ts. Every handler here only
// ever needs `deps` plus at most `mutateSave`/`ensureCommercial`, bound into a small `ctx` object (now
// sourced from `this.core`) and handed to a free function in ./liveops/*.ts — see economy.ts's header
// for why this ctx-bind shape is kept unchanged in this batch.
// - liveops/helpers.ts:      deliverRetentionReward (shared card/equipment delivery step, deps-only)
// - liveops/achievements.ts: getAchievements + claimAchievement (S9)
// - liveops/retention.ts:    getRetention + claimCheckin/claimDailyReward/claimWeeklyChest (B5)
// - liveops/events.ts:       getEvents + claimEventReward (B6)
// - liveops/lobbyBadges.ts:  getLobbyBadges (aggregated cross-domain red-dot fetch, P1-4)
// - liveops/profile.ts:      getTitles + equipTitle/equipAvatar/equipSkin/setFlag (S10 + prefs)
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type MetaCore } from './base.js';
import { getAchievementsHandler, claimAchievementHandler } from './liveops/achievements.js';
import {
  getRetentionHandler,
  claimCheckinHandler,
  claimDailyRewardHandler,
  claimWeeklyChestHandler,
} from './liveops/retention.js';
import { getEventsHandler, claimEventRewardHandler } from './liveops/events.js';
import { getLobbyBadgesHandler } from './liveops/lobbyBadges.js';
import {
  getTitlesHandler,
  equipTitleHandler,
  equipAvatarHandler,
  equipSkinHandler,
  setFlagHandler,
} from './liveops/profile.js';

type LiveOpsHandlers = Pick<
  MetaHandlers,
  | 'getAchievements' | 'claimAchievement' | 'getRetention' | 'claimCheckin' | 'claimDailyReward'
  | 'claimWeeklyChest'
  | 'getEvents' | 'claimEventReward' | 'getTitles' | 'equipTitle' | 'equipAvatar' | 'equipSkin'
  | 'setFlag' | 'getLobbyBadges'
>;

export class LiveOpsService {
  constructor(private readonly core: MetaCore) {}

    async getAchievements(...args: Parameters<LiveOpsHandlers['getAchievements']>) {
      return getAchievementsHandler(this.core.deps, args[0]);
    }

    async claimAchievement(...args: Parameters<LiveOpsHandlers['claimAchievement']>) {
      return claimAchievementHandler(
        { deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core), ensureCommercial: this.core.ensureCommercial.bind(this.core) },
        ...args,
      );
    }

    async getRetention(...args: Parameters<LiveOpsHandlers['getRetention']>) {
      return getRetentionHandler(this.core.deps, args[0]);
    }

    async claimCheckin(...args: Parameters<LiveOpsHandlers['claimCheckin']>) {
      return claimCheckinHandler(
        { deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core), ensureCommercial: this.core.ensureCommercial.bind(this.core) },
        ...args,
      );
    }

    async claimDailyReward(...args: Parameters<LiveOpsHandlers['claimDailyReward']>) {
      return claimDailyRewardHandler(
        { deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core), ensureCommercial: this.core.ensureCommercial.bind(this.core) },
        ...args,
      );
    }

    async claimWeeklyChest(...args: Parameters<LiveOpsHandlers['claimWeeklyChest']>) {
      return claimWeeklyChestHandler(
        { deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core), ensureCommercial: this.core.ensureCommercial.bind(this.core) },
        ...args,
      );
    }

    async getEvents(...args: Parameters<LiveOpsHandlers['getEvents']>) {
      return getEventsHandler(this.core.deps, ...args);
    }

    async claimEventReward(...args: Parameters<LiveOpsHandlers['claimEventReward']>) {
      return claimEventRewardHandler(this.core.deps, ...args);
    }

    async getLobbyBadges(...args: Parameters<LiveOpsHandlers['getLobbyBadges']>) {
      return getLobbyBadgesHandler(this.core.deps, args[0]);
    }

    async getTitles(...args: Parameters<LiveOpsHandlers['getTitles']>) {
      return getTitlesHandler(this.core.deps, args[0]);
    }

    async equipTitle(...args: Parameters<LiveOpsHandlers['equipTitle']>) {
      return equipTitleHandler({ deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core) }, ...args);
    }

    async equipAvatar(...args: Parameters<LiveOpsHandlers['equipAvatar']>) {
      return equipAvatarHandler({ deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core) }, ...args);
    }

    async equipSkin(...args: Parameters<LiveOpsHandlers['equipSkin']>) {
      return equipSkinHandler({ deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core) }, ...args);
    }

    async setFlag(...args: Parameters<LiveOpsHandlers['setFlag']>) {
      return setFlagHandler({ deps: this.core.deps, mutateSave: this.core.mutateSave.bind(this.core) }, ...args);
    }
}
