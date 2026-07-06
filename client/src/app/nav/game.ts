// Campaign / battle / growth navigation: local PvP-vs-AI, campaign map + level prep + campaign match,
// collection, card roster, equipment, stats, leaderboard, achievements, titles, tutorial.
// Extracted from createAppCore.
import * as analytics from '../../analytics';
import { getLevel, CAMPAIGN_LEVEL_ORDER, achievementStatDelta, type AIDifficulty } from '../../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { computeStars, remainingHpPct } from '../../game/meta/campaignRewards';
import { t, type TranslationKey } from '../../i18n';
import { ApiError } from '../../net/ApiClient';
import { serverReplayToReplay } from '../../net/serverReplay';
import { EQUIP_SLOT } from '../equipSlot';
import { genUuid } from '../../platform/uuid';
import type { EquipSlot } from '../../game/meta/SaveData';
import { toEngineCardInstances } from '../../game/meta/cardDefs';
import type { IconKind } from '../../render/icons';
import type { AppCtx, Nav } from '../appCtx';
import { PLAYER_PUBLIC_ID_KEY, PLAYER_NAME_KEY, TOKEN_KEY, TUTORIAL_DONE_FLAG } from '../appConstants';

type GameNav = Pick<Nav,
  'goGame' | 'goCampaignMap' | 'goLevelPrep' | 'goCollection' | 'goCardRoster' | 'goEquipment' |
  'goStats' | 'goLeaderboard' | 'goAchievements' | 'goCampaign' | 'goTutorial' | 'goTitles'>;

export function createGameNav(ctx: AppCtx): GameNav {
  const { api, saveManager, platform, state, views, nav, keepReplay, resolvePvpDeck } = ctx;

  /**
   * Local PvP-vs-AI match. `opts.fromBotFallback` = triggered by a matchmaking-timeout fallback
   * (feature flag match_bot_fallback): uses the server-supplied seed for determinism; analytics
   * tags distinguish intentional practice from bot-fallback sessions. `opts.difficulty` (1–10,
   * engine AISystem.ts) is rolled from ELO by the caller (matchsvc for bot-fallback, or the
   * player's own saved ELO for a manually-started practice match) — omit for the engine default.
   */
  function goGame(opts?: { seed?: number; difficulty?: AIDifficulty; fromBotFallback?: boolean }): void {
    state.inLobby = false;
    platform.onGameplayStart();
    const mode = opts?.fromBotFallback ? 'pvp_bot_fallback' : 'pvp_ai';
    analytics.track('game_start', { mode });
    const gameStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay) {
        analytics.track('game_end', {
          mode,
          result: winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw',
          duration_sec: Math.round((Date.now() - gameStartTs) / 1000),
        });
        // Bot-fallback matches are played entirely client-local (matchsvc issues no ticket/gameUrl),
        // so this is the only settlement hook for them: credits the daily task + (below threshold)
        // a small ELO nudge (SEASON_DESIGN §match_bot_fallback). Manually-chosen practice matches
        // (fromBotFallback=false) are not reported — only the queue-timeout fallback counts.
        // Draws (winner===2) report nothing: there's no clear win/loss to settle.
        if (opts?.fromBotFallback && api && (winner === 0 || winner === 1)) {
          void api.submitBotResult(winner === 0).then((res) => {
            saveManager.update((s) => { s.pvp.elo = res.elo; s.pvp.rank = res.rank; });
          }).catch(() => {
            // Best-effort: offline/expired-token failures don't block the result screen.
          });
        }
        void nav.goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() {
        analytics.track('game_end', { mode, result: 'abandon', duration_ticks: 0 });
        nav.goLobby();
      },
    }, {
      equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null,
      // PvP-vs-AI must honour the same ELO card-unlock gate as online PvP (PVP_LOADOUT §3/§6.3):
      // filter both sides' draw pool to the player's current-elo-validated deck (mirror match).
      // Without this the local engine draws from the full pool and leaks locked units (runner/splitter/…).
      decks: (() => { const d = resolvePvpDeck(); return { top: d, bottom: d }; })(),
      ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts?.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
    });
  }

  function goCampaignMap(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'CampaignMapScene' });
    views.showCampaignMap({
      onBack() { nav.goLobby(); },
      onSelectLevel(levelId) { goLevelPrep(levelId); },
      onOpenCollection() { goCollection(goCampaignMap, 'skins'); },
      // Equipment system is server-authoritative (enhancement rolls / coin deduction / inventory) → entry only available when logged in online (E5).
      ...(api ? { onOpenEquipment: () => goEquipment() } : {}),
      getStars: () => saveManager.get().progress.stars,
      getCleared: () => saveManager.get().progress.cleared,
      // PvE is server-authoritative: clearing / unlocking new levels requires an online connection (§8 decision 4). Offline, only previously unlocked levels can be replayed; new unlocks are gated.
      isOnline: () => saveManager.online(),
      getPendingLevels: () => saveManager.getPendingClears().map((p) => p.levelId),
    });
  }

  function goLevelPrep(levelId: string): void {
    const level = getLevel(levelId);
    if (!level) { goCampaignMap(); return; }
    const levelNumber = CAMPAIGN_LEVEL_ORDER.indexOf(levelId) + 1 || 1;
    state.inLobby = false;
    analytics.track('level_attempt', {
      level_id: levelId,
      stars_before: saveManager.get().progress.stars[levelId] ?? 0,
    });
    analytics.track('screen_view', { scene: 'LevelPrepScene' });
    views.showLevelPrep({
      onBack() { analytics.track('level_abandon', { level_id: levelId, phase: 'prep' }); goCampaignMap(); },
      onStart() { analytics.track('screen_view', { scene: 'GameScene' }); goCampaign(levelId); },
      levelNumber,
      objective: level.objective,
      ...(level.briefKey ? { brief: t(level.briefKey as TranslationKey) } : {}),
      ...(level.story?.introKey ? { intro: t(level.story.introKey as TranslationKey) } : {}),
      // A4 stamina system
      staminaCost: level.staminaCost ?? 1,
      getStamina: () => saveManager.get().stamina ?? { current: 120, regenAt: 0 },
      onBuyStamina() {
        if (!api) return;
        void api.purchaseStamina().then((res) => {
          // Update the local stamina mirror, then re-enter LevelPrep to refresh the UI.
          saveManager.update((s) => { s.stamina = res.stamina; });
          goLevelPrep(levelId);
        }).catch(() => {
          // Insufficient coins: fail silently → fall back to the shop route
          nav.goShop(() => goLevelPrep(levelId));
        });
      },
    });
  }

  function goCollection(back: () => void, initialTab: 'cards' | 'skins' = 'cards'): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'CollectionScene' });
    // Equipment merged into the "Growth" section (LOBBY_IA_REDESIGN §3): the 4th "Equipment" tab
    // is only active when logged in online; back from equipment returns to this collection page
    // (preserving the active sub-tab).
    const equipLoggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    views.showCollection({
      onBack: back,
      initialTab,
      ...(api && equipLoggedIn ? { onOpenEquipment: () => goEquipment(() => goCollection(back, initialTab), 'collection') } : {}),
      getSkins: () => saveManager.get().inventory.skins,
      getEquipped: () => saveManager.get().equipped[EQUIP_SLOT] ?? null,
      equip: (skinId) => {
        saveManager.update((d) => {
          if (skinId === null) delete d.equipped[EQUIP_SLOT];
          else d.equipped[EQUIP_SLOT] = skinId;
        });
      },
    });
  }

  /**
   * Hero Roster (CC-6): owned card instances — level / troops / gear / feed / lock.
   * Server-authoritative (feed/lock mutate server-side; SaveData is a read-only mirror) → requires an
   * online login; offline / not logged in falls back to `back`. Entered from the lobby "cards" nav slot
   * (CHARACTER_CARDS_DESIGN §10). Per-card gear is edited by jumping to EquipmentScene with the card's
   * instance id, returning here on back.
   */
  function goCardRoster(back: () => void = () => nav.goLobby()): void {
    if (!api) { back(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'CardScene' });
    views.showCardRoster({
      onBack() { back(); },
      getSave: () => saveManager.get(),
      async feedCards(targetCardId, materialCardIds) {
        try {
          const { save, levelsGained } = await client.feedCards(targetCardId, materialCardIds, genUuid());
          saveManager.adoptServer(save);
          analytics.track('card_feed', { target_id: targetCardId, material_count: materialCardIds.length, levels_gained: levelsGained });
          return { ok: true as const, levelsGained };
        } catch { return { ok: false as const, key: 'roster.err.generic' as TranslationKey }; }
      },
      async setCardLock(cardInstanceId, locked) {
        try {
          const { save } = await client.setCardLock(cardInstanceId, locked);
          saveManager.adoptServer(save);
          analytics.track('card_lock', { card_instance_id: cardInstanceId, locked });
          return { ok: true as const };
        } catch { return { ok: false as const, key: 'roster.err.generic' as TranslationKey }; }
      },
      // Per-card gear editing (CC-1 flow: CardScene → EquipmentScene → back to roster).
      openEquipment: (cardInstanceId: string) => goEquipment(() => goCardRoster(back), 'none', cardInstanceId),
      // Standalone equipment bag as a roster peer (LOBBY_IA): [Cards|Equipment] group; no active card.
      openEquipmentBag: () => goEquipment(() => goCardRoster(back), 'roster', ''),
    });
  }

  /** Map equipment endpoint error codes → i18n key (E5). */
  function equipErrKey(e: unknown): TranslationKey {
    if (e instanceof ApiError) {
      switch (e.code) {
        case 'INSUFFICIENT_MATERIALS': return 'equip.err.materials';
        case 'INSUFFICIENT_FUNDS':     return 'equip.err.coins';
        case 'INVENTORY_FULL':         return 'equip.err.full';
        case 'ENHANCE_MAX_LEVEL':      return 'equip.err.maxLevel';
        case 'NOT_SALVAGEABLE':        return 'equip.err.notSalvageable';
        case 'INVALID_SLOT':           return 'equip.err.invalidSlot';
        case 'EQUIP_LOCKED':           return 'equip.err.locked';
        case 'EQUIP_IN_USE':           return 'equip.err.inUse';
        case 'NOT_REFORGE_ELIGIBLE':   return 'equip.err.notReforgeEligible';
        case 'INVALID_RARITY':         return 'equip.err.invalidRarity';
      }
    }
    return 'equip.err.generic';
  }

  /**
   * Equipment system (E5). Server-authoritative; requires an online login. Can be entered from
   * the campaign map (default back) or the "Growth" tab (LOBBY_IA_REDESIGN §3, back=collection page);
   * `back` determines where the user returns to.
   */
  function goEquipment(back: () => void = goCampaignMap, group: 'none' | 'collection' | 'roster' = 'none', cardInstanceId = ''): void {
    if (!api) { back(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'EquipmentScene' });
    // Growth group peer tabs (LOBBY_IA_REDESIGN P1.5): a top [<peer>|Equipment] strip is shown when
    // entered from the collection page ([Collection|Equipment]) or the card roster ([Cards|Equipment]);
    // tapping the peer navigates back (= back). Campaign / per-card entry does not inject this → plain back.
    const peerTab = group === 'collection'
      ? { labelKey: 'collection.title' as TranslationKey, icon: 'book' as IconKind, onSelect: () => back() }
      : group === 'roster'
        ? { labelKey: 'roster.title' as TranslationKey, icon: 'cards' as IconKind, onSelect: () => back() }
        : undefined;
    views.showEquipment({
      onBack() { back(); },
      ...(peerTab ? { peerTab } : {}),
      activeCardInstanceId: cardInstanceId,
      getSave: () => saveManager.get(),
      async craft(defId: string) {
        try {
          const { save } = await client.craftEquipment(defId, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_craft', { def_id: defId });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async enhance(instanceId: string, useProtect?: boolean) {
        try {
          const { success, instance, save } = await client.enhanceEquipment(instanceId, genUuid(), useProtect);
          saveManager.adoptServer(save);
          analytics.track('equip_enhance', { def_id: instance.defId, from_level: instance.level - (success ? 1 : 0), success, use_protect: !!useProtect });
          return { ok: true as const, success, level: instance.level };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async salvage(instanceIds: string[]) {
        try {
          const { save } = await client.salvageEquipment(instanceIds, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_salvage', { count: instanceIds.length });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async equip(slot: EquipSlot, instanceId: string | null, cid: string) {
        try {
          const { save } = await client.equipEquipment(slot, instanceId, cid);
          saveManager.adoptServer(save);
          analytics.track('equip_equip', { slot, instance_id: instanceId ?? '', card_instance_id: cid });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async reforge(targetId: string, materialId: string) {
        try {
          const { save } = await client.reforgeEquipment(targetId, materialId, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_reforge', { target_id: targetId });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
    });
  }

  function goStats(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'StatsScene' });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const pvp = saveManager.get().pvp;
    views.showStats({
      onBack: () => nav.goLobby(),
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
      ...(client && loggedIn ? { onOpenAchievements: () => goAchievements(), hasClaimableAchievement: state.achievementClaimable } : {}),
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
      ...(loggedIn ? { onOpenTitles: () => goTitles(goStats) } : {}),
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

  function goAchievements(): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'AchievementScene' });
    // Mid-funnel achievement step (S9-8, ANALYTICS_DESIGN §5.7): unlock toast → view wall → claim. Only counts as a valid funnel step when online.
    const onlineWall = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    analytics.track('achievement_view_wall', { online: onlineWall });
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showAchievements({
      onBack: () => goStats(),
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
        saveManager.update((d) => { d.equipped['title'] = titleId; });
      },
    });
  }

  function goCampaign(levelId: string | undefined): void {
    const level = levelId ? getLevel(levelId) : null;
    if (!level || !levelId) { nav.goLobby(); return; }
    state.inLobby = false;
    platform.onGameplayStart();
    analytics.track('game_start', { mode: 'campaign', level_id: levelId });
    const campaignStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay) {
        // Persist the replay to disk first (once), serving both the result-screen playback and
        // potential L1 spot-check re-evaluation (§8.6).
        const kept = keepReplay(replay);
        const durationSec = Math.round((Date.now() - campaignStartTs) / 1000);
        if (winner === 0) {
          const pct = remainingHpPct(stats[0].damageTakenByBase);
          const stars = computeStars(level.rewards?.starThresholds, pct);
          analytics.track('level_complete', {
            level_id: levelId,
            stars,
            duration_sec: durationSec,
          });
          // Server-authoritative settlement (§8): online → POST /pve/clear (if selected for spot-check,
          // the kept replay is submitted via /pve/verify for re-evaluation);
          // offline → enqueue for deferred settlement (fire-and-forget; save / pending are re-read on
          // returning to CampaignMap to reflect the state).
          if (stars > 0) void saveManager.recordClear(levelId, stars, kept, achievementStatDelta(stats[0]));
        } else {
          analytics.track('game_end', {
            mode: 'campaign',
            result: 'loss',
            level_id: levelId,
            duration_sec: durationSec,
          });
        }
        const outroText = (winner === 0 && level.story?.outroKey) ? t(level.story.outroKey as TranslationKey) : undefined;
        void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroText, goCampaignMap, t('result.backToMap'));
      },
      onExitToLobby() {
        analytics.track('level_abandon', { level_id: levelId, phase: 'in_game' });
        nav.goLobby();
      },
    }, {
      level,
      equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null,
      // Hero Roster → engine (card level + per-card equipment buff blueprints, §9) and to the
      // renderer (worn gear drawn on units, §20.4). PvE-only; PvP omits both (hard wall).
      cardInstances: toEngineCardInstances(saveManager.get().cardInv ?? {}),
      equipmentInv: saveManager.get().equipmentInv ?? {},
    });
  }

  /**
   * Dedicated tutorial level ch0_tutorial (FTUE step ⑤, ONBOARDING_DESIGN §3). Never fails: the
   * director owns the endgame, so winner is always the local player. Both completion and skip write
   * tutorial_done then return to the lobby; does not count toward campaign progress (recordClear is
   * not called).
   */
  function goTutorial(): void {
    const level = getLevel(TUTORIAL_LEVEL_ID);
    if (!level) { nav.goLobby(); return; }  // If the tutorial level is missing, skip silently rather than blocking new players.
    state.inLobby = false;
    platform.onGameplayStart();
    analytics.track('tutorial_start', { level_id: TUTORIAL_LEVEL_ID });
    views.showGame({
      onGameEnd(_winner, _stats, _replay) {
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_complete', { level_id: TUTORIAL_LEVEL_ID });
        // §5 first-win hook: graduation = first win; the daily check-in is surfaced via the lobby red dot, so no additional coin source is added here.
        nav.goLobby();
      },
      onExitToLobby() {  // Skip tutorial
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_skip', { step: 'tutorial' });
        nav.goLobby();
      },
    }, { level, tutorial: true });
  }

  return {
    goGame, goCampaignMap, goLevelPrep, goCollection, goCardRoster, goEquipment,
    goStats, goLeaderboard, goAchievements, goCampaign, goTutorial, goTitles,
  };
}
