// Career hub navigation: Stats / Leaderboard / Achievements / Titles / Codex.
// Split out of createGameNav (see game.ts). Self-contained — no calls into
// campaignRoster.ts's functions, only ctx (nav.goLobby / nav.goReplay) and each other.
//
// ⚠️ Career 侧边栏 tab 切换的 back 语义 (claudedocs/client-modules.md 第 38 条): Stats/Titles/
// Achievements/Codex are peer tabs of one Career hub (ui/widgets/CareerTabs.ts), not a navigation
// stack — goStats/goAchievements/goTitles/goCodex must transparently pass through the caller's
// `back` closure to each other when switching tabs (not hardcode a hop to goStats()). Only a
// standalone entry (no `back` arg) defaults to goLobby/goStats. Regression coverage:
// client/test/careerNav-backNavigation.test.ts — preserve this call-through behavior byte-for-byte.
import * as analytics from '../../../analytics';
import { CAMPAIGN_LEVEL_ORDER } from '../../../game';
import { serverReplayToReplay } from '../../../net/serverReplay';
import { CARD_DEFS } from '../../../game/meta/cardDefs';
import type { AppCtx, Nav } from '../../appCtx';
import { PLAYER_PUBLIC_ID_KEY, PLAYER_NAME_KEY, TOKEN_KEY } from '../../appConstants';

type CareerNav = Pick<Nav, 'goStats' | 'goLeaderboard' | 'goAchievements' | 'goTitles' | 'goCodex'>;

export function createCareerNav(ctx: AppCtx): CareerNav {
  const { api, saveManager, platform, state, views, nav } = ctx;

  function goStats(back: () => void = () => nav.goLobby()): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'StatsScene' });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const pvp = saveManager.get().pvp;
    views.showStats({
      onBack: () => back(),
      // Fetch server-side match history and enable replay viewing only when logged in online;
      // offline / not logged in: omit these (the page shows an offline notice).
      ...(client && loggedIn
        ? {
            loadHistory: () => client.getMatchHistory(),
            onWatchReplay: (roomId: string) => {
              void client
                .getMatchReplay(roomId)
                .then((sr) => nav.goReplay(serverReplayToReplay(sr), goStats))
                .catch(() => {
                  /* Replay missing or decode failed: best-effort, stay on stats */
                });
            },
          }
        : {}),
      ...(client && loggedIn ? { onOpenAchievements: () => goAchievements(back), hasClaimableAchievement: state.achievementClaimable } : {}),
      ...(client && loggedIn
        ? {
            onOpenLeaderboard: () => goLeaderboard(),
            getMyRank: async () => {
              const myId = platform.storage.getItem(PLAYER_PUBLIC_ID_KEY);
              if (!myId) return null;
              try {
                const lb = await client.getLeaderboard();
                return lb.entries.find((e) => e.publicId === myId)?.rank ?? null;
              } catch {
                return null;
              }
            },
          }
        : {}),
      ...(platform.storage.getItem(PLAYER_NAME_KEY) ? { playerName: platform.storage.getItem(PLAYER_NAME_KEY)! } : {}),
      // Titles merged into the "Career" top bar (LOBBY_IA_REDESIGN §3); battle pass has moved to the "Shop" tab and is no longer linked here.
      // Thread `back` through (not goStats) so switching tabs within the Career hub doesn't add a
      // hop: Titles' own back button should return straight to wherever Stats was entered from.
      ...(loggedIn ? { onOpenTitles: () => goTitles(back) } : {}),
      ...(loggedIn ? { onOpenCodex: () => goCodex(back) } : {}),
      // Season banner: read from save pvp.seasonNo; endAt comes from the leaderboard cache or stays undefined (displays "ended").
      ...(pvp.seasonNo ? { season: { seasonNo: pvp.seasonNo, endAt: 0 } } : {}),
      getStats: () => {
        const save = saveManager.get();
        const stars = Object.values(save.progress.stars).reduce((a, b) => a + b, 0);
        return {
          pvp: {
            rank: save.pvp.rank,
            elo: save.pvp.elo,
            wins: save.pvp.wins,
            losses: save.pvp.losses,
            streak: save.pvp.streak,
          },
          cleared: save.progress.cleared.length,
          totalLevels: CAMPAIGN_LEVEL_ORDER.length,
          stars,
          skinsOwned: save.inventory.skins.length,
          materials: save.materials,
        };
      },
    });
  }

  function goLeaderboard(onBack?: () => void): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'LeaderboardScene' });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showLeaderboard({
      onBack: onBack ?? (() => goStats()),
      ...(client && loggedIn
        ? { loadLeaderboard: () => client.getLeaderboard() }
        : {}),
    });
  }

  function goAchievements(back: () => void = () => goStats()): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'AchievementScene' });
    // Mid-funnel achievement step (S9-8, ANALYTICS_DESIGN §5.7): unlock toast → view wall → claim. Only counts as a valid funnel step when online.
    const onlineWall = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    analytics.track('achievement_view_wall', { online: onlineWall });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showAchievements({
      onBack: () => back(),
      onOpenStats: () => goStats(back),
      onOpenTitles: () => goTitles(back),
      onOpenCodex: () => goCodex(back),
      // Fetch achievements and enable claiming only when logged in online;
      // offline / not logged in: the page shows a "log in to view" message.
      ...(client && loggedIn
        ? {
            loadAchievements: () => client.getAchievements(),
            onClaim: async (achId: string, tier: number) => {
              const { save, granted } = await client.claimAchievement(achId, tier);
              saveManager.adoptServer(save);
              analytics.track('achievement_claim', { ach_id: achId, tier, coins: granted });
              return granted;
            },
          }
        : {}),
    });
  }

  /** Title wall (S10). Entered from the "Career" top bar (back=goStats); no longer accessible from settings. */
  function goTitles(back: () => void = goStats): void {
    const save = saveManager.get();
    views.showTitles({
      onBack() { back(); },
      titles: save.titles ?? [],
      equippedTitle: save.equipped['title'] ?? '',
      onEquip(titleId: string) {
        saveManager.equipTitle(titleId || null);
      },
      onOpenStats: () => goStats(back),
      onOpenAchievements: () => goAchievements(back),
      onOpenCodex: () => goCodex(back),
      hasClaimableAchievement: state.achievementClaimable,
    });
  }

  /**
   * Read-only card compendium (LOBBY_IA_REDESIGN §15, folded in from the retired CollectionScene).
   * Career hub peer of Stats/Titles/Achievements; entered the same way they are (back=goStats).
   */
  function goCodex(back: () => void = goStats): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'CardCodexScene' });
    views.showCardCodex({
      onBack() { back(); },
      getOwnedUnitTypes: () => {
        const save = saveManager.get();
        const owned = new Set<string>();
        for (const inst of Object.values(save.cardInv ?? {})) {
          const def = CARD_DEFS[inst.defId];
          if (def) owned.add(def.unitType);
        }
        return owned;
      },
      onOpenStats: () => goStats(back),
      onOpenTitles: () => goTitles(back),
      onOpenAchievements: () => goAchievements(back),
      hasClaimableAchievement: state.achievementClaimable,
    });
  }

  return { goStats, goLeaderboard, goAchievements, goTitles, goCodex };
}
