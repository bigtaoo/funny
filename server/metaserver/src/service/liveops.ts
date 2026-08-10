// Live-ops progression: achievements (S9), retention check-in / daily tasks (B5), limited-time events
// (B6), and player titles (S10) — mixin facade. Counts are written only at authoritative settlement
// points elsewhere; these handlers read definitions/progress and deliver one-time coin/title claims.
//
// Split into independent function modules (2026-08-10, 独立函数模块 form, pve.ts's sibling — same
// "already in the mixin chain but grown fat" case: every handler here only ever needed `this.deps` plus
// at most `this.mutateSave`/`this.ensureCommercial` (both `protected` on MetaServiceBase), never
// `this.rejectIfBanned`/`this.readStaminaSnapshot`. LiveOpsMixin's class body reads `this.deps` and
// `.bind(this)`s the two protected methods each handler needs into a plain `ctx` object, then hands
// that to a free function outside the class — see pve.ts's facade comment for why this sidesteps the
// protected-member/structural-typing wall that rules out independent-class-composition here. No
// behavior change: every method body was moved verbatim.
// - liveops/helpers.ts:      deliverRetentionReward (shared card/equipment delivery step, deps-only)
// - liveops/achievements.ts: getAchievements + claimAchievement (S9)
// - liveops/retention.ts:    getRetention + claimCheckin/claimDailyReward/claimWeeklyChest (B5)
// - liveops/events.ts:       getEvents + claimEventReward (B6)
// - liveops/lobbyBadges.ts:  getLobbyBadges (aggregated cross-domain red-dot fetch, P1-4)
// - liveops/profile.ts:      getTitles + equipTitle/equipAvatar/equipSkin/setFlag (S10 + prefs)
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type Constructor, type MetaBaseCtor } from './base.js';
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

export function LiveOpsMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<LiveOpsHandlers> {
  return class extends Base {
    async getAchievements(...args: Parameters<LiveOpsHandlers['getAchievements']>) {
      return getAchievementsHandler(this.deps, args[0]);
    }

    async claimAchievement(...args: Parameters<LiveOpsHandlers['claimAchievement']>) {
      return claimAchievementHandler(
        { deps: this.deps, mutateSave: this.mutateSave.bind(this), ensureCommercial: this.ensureCommercial.bind(this) },
        ...args,
      );
    }

    async getRetention(...args: Parameters<LiveOpsHandlers['getRetention']>) {
      return getRetentionHandler(this.deps, args[0]);
    }

    async claimCheckin(...args: Parameters<LiveOpsHandlers['claimCheckin']>) {
      return claimCheckinHandler(
        { deps: this.deps, mutateSave: this.mutateSave.bind(this), ensureCommercial: this.ensureCommercial.bind(this) },
        ...args,
      );
    }

    async claimDailyReward(...args: Parameters<LiveOpsHandlers['claimDailyReward']>) {
      return claimDailyRewardHandler(
        { deps: this.deps, mutateSave: this.mutateSave.bind(this), ensureCommercial: this.ensureCommercial.bind(this) },
        ...args,
      );
    }

    async claimWeeklyChest(...args: Parameters<LiveOpsHandlers['claimWeeklyChest']>) {
      return claimWeeklyChestHandler(
        { deps: this.deps, mutateSave: this.mutateSave.bind(this), ensureCommercial: this.ensureCommercial.bind(this) },
        ...args,
      );
    }

    async getEvents(...args: Parameters<LiveOpsHandlers['getEvents']>) {
      return getEventsHandler(this.deps, ...args);
    }

    async claimEventReward(...args: Parameters<LiveOpsHandlers['claimEventReward']>) {
      return claimEventRewardHandler(this.deps, ...args);
    }

    async getLobbyBadges(...args: Parameters<LiveOpsHandlers['getLobbyBadges']>) {
      return getLobbyBadgesHandler(this.deps, args[0]);
    }

    async getTitles(...args: Parameters<LiveOpsHandlers['getTitles']>) {
      return getTitlesHandler(this.deps, args[0]);
    }

    async equipTitle(...args: Parameters<LiveOpsHandlers['equipTitle']>) {
      return equipTitleHandler({ deps: this.deps, mutateSave: this.mutateSave.bind(this) }, ...args);
    }

    async equipAvatar(...args: Parameters<LiveOpsHandlers['equipAvatar']>) {
      return equipAvatarHandler({ deps: this.deps, mutateSave: this.mutateSave.bind(this) }, ...args);
    }

    async equipSkin(...args: Parameters<LiveOpsHandlers['equipSkin']>) {
      return equipSkinHandler({ deps: this.deps, mutateSave: this.mutateSave.bind(this) }, ...args);
    }

    async setFlag(...args: Parameters<LiveOpsHandlers['setFlag']>) {
      return setFlagHandler({ deps: this.deps, mutateSave: this.mutateSave.bind(this) }, ...args);
    }
  };
}
