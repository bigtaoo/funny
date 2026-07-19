// Campaign / battle / growth navigation: local PvP-vs-AI, campaign map + level prep + campaign match,
// collection, card roster, equipment, stats, leaderboard, achievements, titles, tutorial.
// Extracted from createAppCore.
import * as analytics from '../../analytics';
import { getLevel, CAMPAIGN_LEVEL_ORDER, achievementStatDelta, type AIDifficulty } from '../../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { computeStars, buildStarContext } from '../../game/meta/campaignRewards';
import { t, type TranslationKey } from '../../i18n';
import { ApiError } from '../../net/ApiClient';
import { serverReplayToReplay } from '../../net/serverReplay';
import { allEquippedSkins, skinEquipKey } from '../../game/meta/skinDefs';
import { genUuid } from '../../platform/uuid';
import type { EquipSlot } from '../../game/meta/SaveData';
import { toEngineCardInstances, CARD_DEFS } from '../../game/meta/cardDefs';
import type { IconKind } from '../../render/icons';
import type { AppCtx, Nav } from '../appCtx';
import { PLAYER_PUBLIC_ID_KEY, PLAYER_NAME_KEY, TOKEN_KEY, TUTORIAL_DONE_FLAG } from '../appConstants';
import { pickPracticeDifficulty } from './lobby';

type GameNav = Pick<Nav,
  'goGame' | 'goCampaignMap' | 'goLevelPrep' | 'goCardRoster' | 'goEquipment' |
  'goStats' | 'goLeaderboard' | 'goAchievements' | 'goCampaign' | 'goTutorial' | 'goTitles' | 'goCodex'>;

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
        // "Fight again" jumps straight back into a fresh practice match (re-rolls
        // AI difficulty off the current ELO, same as the lobby's own entry point)
        // instead of dropping the player back at the lobby first.
        void nav.goResult(
          winner, stats, 0, keepReplay(replay), undefined, undefined, undefined,
          () => goGame({ difficulty: pickPracticeDifficulty(saveManager.get().pvp.elo) }),
        );
      },
      onExitToLobby() {
        analytics.track('game_end', { mode, result: 'abandon', duration_ticks: 0 });
        nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
    }, {
      equippedSkins: allEquippedSkins(saveManager.get().equipped),
      // PvP-vs-AI must honour the same ELO card-unlock gate as online PvP (PVP_LOADOUT §3/§6.3):
      // filter both sides' draw pool to the player's current-elo-validated deck (mirror match).
      // Without this the local engine draws from the full pool and leaks locked units (runner/splitter/…).
      decks: (() => { const d = resolvePvpDeck(); return { top: d, bottom: d }; })(),
      // Replay labels: human at the bottom, AI at the top (owner-indexed, matchEngine writes meta.players).
      players: { bottom: ctx.playerName(), top: t('replay.aiOpponent') },
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
      // Single growth-hub entry (LOBBY_IA_REDESIGN §9/§15): lands directly on Equipment (peer-tab
      // back to the roster) when the server-authoritative equipment system is reachable (E5);
      // falls back to the roster itself when offline/logged out (CardScene now works read-only offline).
      onOpenEquipment() {
        const equipLoggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
        if (api && equipLoggedIn) { goEquipment(() => goCardRoster(goCampaignMap), 'roster', '', () => goCardRoster(goCampaignMap, 'skins')); return; }
        goCardRoster(goCampaignMap);
      },
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
    // A4 stamina system: cost is deducted at entry (onStart), not on clear — no refund on retreat/loss.
    const staminaCost = level.staminaCost ?? 10;
    views.showLevelPrep({
      onBack() { analytics.track('level_abandon', { level_id: levelId, phase: 'prep' }); goCampaignMap(); },
      onStart() {
        // Deducts locally even offline; UI already blocks Start when insufficient, so this is a defensive no-op.
        if (!saveManager.spendStaminaForLevel(levelId, staminaCost)) return;
        analytics.track('screen_view', { scene: 'GameScene' });
        goCampaign(levelId);
      },
      levelNumber,
      objective: level.objective,
      ...(level.rewards ? { rewards: level.rewards } : {}),
      ...(level.briefKey ? { brief: t(level.briefKey as TranslationKey) } : {}),
      ...(level.story?.introKey ? { intro: t(level.story.introKey as TranslationKey) } : {}),
      staminaCost,
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

  /**
   * Hero Roster (CC-6): owned card instances — level / troops / gear / feed / lock / skins.
   * Feed/lock/gear are server-authoritative (require an online login); skins are a client-sync-section
   * write and always work, including offline (LOBBY_IA_REDESIGN §15) — offline/never-logged-in players
   * still get a read-only roster + working skins tab off the local save mirror instead of a dead end.
   * Entered from the lobby "cards" nav slot (CHARACTER_CARDS_DESIGN §10).
   */
  function goCardRoster(back: () => void = () => nav.goLobby(), initialTab: 'list' | 'skins' = 'list'): void {
    const client = api;
    const online = !!client;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'CardScene' });
    views.showCardRoster({
      onBack() { back(); },
      initialTab,
      getSave: () => saveManager.get(),
      async fuseCards(targetCardId, materialCardIds) {
        if (!client) return { ok: false as const, key: 'roster.err.offline' as TranslationKey };
        try {
          const { save } = await client.fuseCards(targetCardId, materialCardIds, genUuid());
          saveManager.adoptServer(save);
          analytics.track('card_fuse', { target_id: targetCardId, material_count: materialCardIds.length });
          return { ok: true as const };
        } catch { return { ok: false as const, key: 'roster.err.generic' as TranslationKey }; }
      },
      async setCardLock(cardInstanceId, locked) {
        if (!client) return { ok: false as const, key: 'roster.err.offline' as TranslationKey };
        try {
          const { save } = await client.setCardLock(cardInstanceId, locked);
          saveManager.adoptServer(save);
          analytics.track('card_lock', { card_instance_id: cardInstanceId, locked });
          return { ok: true as const };
        } catch { return { ok: false as const, key: 'roster.err.generic' as TranslationKey }; }
      },
      // Per-card gear editing + the standalone equipment bag are server-authoritative — omitted offline.
      ...(online ? {
        openEquipment: (cardInstanceId: string, slot?: EquipSlot) => goEquipment(() => goCardRoster(back), 'none', cardInstanceId, undefined, slot),
        openEquipmentBag: () => goEquipment(() => goCardRoster(back), 'roster', '', () => goCardRoster(back, 'skins')),
      } : {}),
      getOwnedSkins: () => saveManager.get().inventory.skins,
      getEquippedSkin: (unitType) => saveManager.get().equipped[skinEquipKey(unitType)] ?? null,
      equipSkin: (unitType, skinId) => {
        saveManager.update((d) => {
          const key = skinEquipKey(unitType);
          if (skinId === null) delete d.equipped[key];
          else d.equipped[key] = skinId;
        });
      },
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
   * the campaign map (default back) or the roster ("Develop" tab); `back` determines where the
   * user returns to.
   */
  function goEquipment(
    back: () => void = goCampaignMap,
    group: 'none' | 'roster' = 'none',
    cardInstanceId = '',
    onSkins?: () => void,
    initialFilterSlot?: EquipSlot,
  ): void {
    if (!api) { back(); return; }
    const client = api;
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'EquipmentScene' });
    // Growth group nav (LOBBY_IA_REDESIGN P1.5/§15): entered from the card roster, the sidebar rail is
    // the full [Cards | Equipment | Skins] group. Cards leads (peerTab, above Equipment); Skins trails
    // (trailingPeers, below Equipment's Inventory/Craft sub-tabs) so it stays visible instead of being
    // dropped. Campaign / per-card entry injects neither → plain back, no rail.
    const peerTab = group === 'roster'
      ? { labelKey: 'roster.title' as TranslationKey, icon: 'cards' as IconKind, onSelect: () => back() }
      : undefined;
    const trailingPeers = group === 'roster' && onSkins
      ? [{ labelKey: 'roster.tab.skins' as TranslationKey, icon: 'brush' as IconKind, onSelect: onSkins }]
      : undefined;
    views.showEquipment({
      onBack() { back(); },
      ...(peerTab ? { peerTab } : {}),
      ...(trailingPeers ? { trailingPeers } : {}),
      activeCardInstanceId: cardInstanceId,
      ...(initialFilterSlot ? { initialFilterSlot } : {}),
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
        saveManager.update((d) => { d.equipped['title'] = titleId; });
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

  function goCampaign(levelId: string | undefined): void {
    const level = levelId ? getLevel(levelId) : null;
    if (!level || !levelId) { nav.goLobby(); return; }
    state.inLobby = false;
    platform.onGameplayStart();
    analytics.track('game_start', { mode: 'campaign', level_id: levelId });
    const campaignStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay, summary) {
        // Persist the replay to disk first (once), serving both the result-screen playback and
        // potential L1 spot-check re-evaluation (§8.6).
        const kept = keepReplay(replay);
        const durationSec = Math.round((Date.now() - campaignStartTs) / 1000);
        if (winner === 0) {
          // Composite star scoring (STAR_SCORING.md): build the same ctx the judge recomputes from.
          const ctx = buildStarContext(level, {
            damageTakenByBase: stats[0].damageTakenByBase,
            elapsedTicks: summary?.elapsedTicks ?? 0,
            enemyLeaks: summary?.enemyLeaks ?? 0,
            escortMinHpPct: summary?.escortMinHpPct ?? null,
            unitsKilled: stats[0].unitsKilled,
          });
          const stars = computeStars(level.rewards?.starThresholds, ctx);
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
        nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
    }, {
      level,
      equippedSkins: allEquippedSkins(saveManager.get().equipped),
      // Replay labels: human at the bottom, the level's forces at the top (owner-indexed).
      players: { bottom: ctx.playerName(), top: t('replay.aiOpponent') },
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
        nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
      onExitToLobby() {  // Skip tutorial
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_skip', { step: 'tutorial' });
        nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
      onTutorialStep(stepKey) {
        analytics.track('tutorial_step', { level_id: TUTORIAL_LEVEL_ID, step_key: stepKey });
      },
    }, { level, tutorial: true });
  }

  return {
    goGame, goCampaignMap, goLevelPrep, goCardRoster, goEquipment,
    goStats, goLeaderboard, goAchievements, goCampaign, goTutorial, goTitles, goCodex,
  };
}
