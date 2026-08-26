// Campaign / battle / roster / equipment navigation: local PvP-vs-AI, campaign map + level prep +
// campaign match, card roster, equipment, tutorial. Split out of createGameNav (see game.ts).
//
// Campaign and roster stay in one factory (not two): they have a genuine two-way call
// dependency inside the original closure — goCampaignMap.onOpenEquipment calls goEquipment/
// goCardRoster (roster), while goEquipment's own default `back` parameter is goCampaignMap
// (campaign) — so splitting them into separate files would need a lazy cross-reference hack
// for no real benefit; see claudedocs/client-modules.md's split-form note for this file.
import * as analytics from '../../../analytics';
import { getLevel, CAMPAIGN_LEVEL_ORDER, achievementStatDelta, type AIDifficulty } from '../../../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { computeStars, buildStarContext } from '../../../game/meta/campaignRewards';
import { t, type TranslationKey } from '../../../i18n';
import { allEquippedSkins, skinEquipKey } from '../../../game/meta/skinDefs';
import { genUuid } from '../../../platform/uuid';
import type { EquipSlot } from '../../../game/meta/SaveData';
import { toEngineCardInstances, FUSION_MATERIAL_COUNT } from '../../../game/meta/cardDefs';
import { teamDisplayName } from '../../../game/meta/teamTroops';
import { WorldApiClient, type CardSLGState } from '../../../net/WorldApiClient';
import type { CardRosterView } from '../../../scenes/CardScene';
import type { IconKind } from '../../../render/icons';
import { matchBadgeTelemetry } from '../../../scenes/ResultScene';
import { buildEquipmentActions } from './equipmentActions';
import type { MountOpts } from '../../AppViews';
import type { AppCtx, Nav } from '../../appCtx';
import { TOKEN_KEY, TUTORIAL_DONE_FLAG } from '../../appConstants';
import { pickPracticeDifficulty } from '../lobby';
import { resolveRealLayerInterlude } from '../../../scenes/realLayerInterludeArt';

type CampaignRosterNav = Pick<Nav,
  'goGame' | 'goCampaignMap' | 'goLevelPrep' | 'goCardRoster' | 'goEquipment' | 'goCampaign' | 'goTutorial'>;

/** See goCardRoster's SLG-fetch comment. */
const CARD_ROSTER_SLG_BUDGET_MS = 2500;

export function createCampaignRosterNav(ctx: AppCtx): CampaignRosterNav {
  const { api, saveManager, platform, state, views, nav, keepReplay, resolvePvpDeck, resolveWorldShard } = ctx;

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
        const result = winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw';
        analytics.track('game_end', {
          mode,
          result,
          duration_sec: Math.round((Date.now() - gameStartTs) / 1000),
        });
        // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8) — local player is owner 0 in vs-AI.
        analytics.track('match_badges', { mode, result, ...matchBadgeTelemetry(stats[0]) });
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

    // Backs getCardState/getTeamName below; openRoster() closes over these by reference, so
    // reassigning them after the roster is already open (see the late-arrival branch further down)
    // is visible the next time either callback is *called* — but nothing calls them again on its
    // own, hence the paired view.applyCardState() to actually trigger a redraw.
    let liveCardState: Record<string, CardSLGState> | undefined;
    let liveTeamNames: Record<string, string> | undefined;

    /**
     * Handle to the roster that is currently on screen, so the equipment overlay opened from it can
     * drive it directly (pop + switch tab) instead of rebuilding it — see openEquipmentBag's onSkins
     * below. Assigned by openRoster; the equip callbacks below only ever run after that.
     */
    let rosterView: CardRosterView | null = null;

    /**
     * Close the equipment overlay and reveal the live roster underneath (ADR-072). The roster kept
     * its scroll offset and open detail modal the whole time, and its save subscription stayed
     * subscribed through the detour, so the gear just equipped is already reflected — nothing to
     * re-fetch here, unlike the SLG map's returnFromCityToMap.
     */
    const returnToRoster = (): void => { views.hideOverlay(); };

    const openRoster = (): CardRosterView => {
      rosterView = views.showCardRoster({
        onBack() { back(); },
        initialTab,
        getSave: () => saveManager.get(),
        onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
        getCardState: () => liveCardState,
        getTeamName: (teamId) => liveTeamNames?.[teamId],
        async fuseCards(targetCardId, materialCardIds) {
          if (!client) return { ok: false as const, key: 'roster.err.offline' as TranslationKey };
          try {
            const { save } = await client.fuseCards(targetCardId, materialCardIds, genUuid());
            saveManager.adoptServer(save);
            analytics.track('card_fuse', { target_id: targetCardId, material_count: materialCardIds.length });
            return { ok: true as const };
          } catch { return { ok: false as const, key: 'roster.err.generic' as TranslationKey }; }
        },
        /**
         * Batch prep (CHARACTER_CARDS_DESIGN §3.2): the whole planned run in ONE request. A short run
         * is a normal response (the server stops at its first bad round) and comes back through
         * `completed`, not as a throw; every round-level code collapses to the same generic line the
         * single-fuse path uses, since they all mean "your view of the roster moved, look again".
         */
        async fuseCardsBatch(rounds) {
          if (!client) return { ok: false as const, key: 'roster.err.offline' as TranslationKey };
          try {
            const { completed, failed, save } = await client.fuseCardsBatch(rounds, genUuid());
            saveManager.adoptServer(save);
            if (completed > 0) {
              analytics.track('card_fuse', { target_id: rounds[0].targetId, material_count: completed * FUSION_MATERIAL_COUNT });
            }
            return { ok: true as const, completed, ...(failed ? { failKey: 'roster.fuseErr' as TranslationKey } : {}) };
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
        // Both open EquipmentScene as an overlay on top of this still-live roster (ADR-072): gear
        // editing is a detour *within* the roster, and the old `goCardRoster(back)` return rebuilt the
        // scene from scratch — dropping the scroll offset and the open detail modal, so a player
        // equipping three pieces onto one card had to scroll back down and re-open it each time.
        ...(online ? {
          openEquipment: (cardInstanceId: string, slot?: EquipSlot) =>
            goEquipment(returnToRoster, 'none', cardInstanceId, undefined, slot, { overlay: true }),
          openEquipmentBag: () => goEquipment(
            returnToRoster,
            'roster',
            '',
            // Skins peer in the overlay's rail: pop back to the live roster and move it to the
            // wardrobe, rather than rebuilding it with `initialTab: 'skins'`.
            () => { views.hideOverlay(); rosterView?.showTab('skins'); },
            undefined,
            { overlay: true },
          ),
        } : {}),
        getOwnedSkins: () => saveManager.get().inventory.skins,
        getEquippedSkin: (unitType) => saveManager.get().equipped[skinEquipKey(unitType)] ?? null,
        equipSkin: (unitType, skinId) => saveManager.equipSkin(unitType, skinId),
      });
      return rosterView;
    };

    // SLG per-card state (troop count / deployed team) lives in worldsvc's PlayerWorldView, separate
    // from the account-scoped SaveData mirror — fetch it best-effort before opening the roster so
    // troop cap / deployed-team status render on first paint. Silently falls back to no SLG state
    // when offline, logged out, or the player has never touched the SLG (getMe/getTeams failure) —
    // the roster still works, it just won't show those fields.
    //
    // Bounded to CARD_ROSTER_SLG_BUDGET_MS regardless of resolveWorldShard's own 3s
    // worldsvc-unreachable fallback: unlike the explicit "enter the SLG" flow (goWorldEntry), the
    // roster is a frequently-tapped lobby screen and shouldn't inherit that full stall if worldsvc
    // is slow/down — better to open without troop/team data than freeze the lobby for multiple
    // seconds. (2026-07-28+1: the budget used to be a flat 1.5s, tighter than resolveWorldShard's own
    // worst case, so a merely-slow-not-down worldsvc reliably lost the SLG fetch entirely — every
    // card in the roster looked never-deployed even when worldsvc/Mongo eventually did answer.
    // Widened to 2.5s, and — since CardScene now exposes applyCardState() (see
    // CardScene/base.ts) — a fetch that resolves *after* the give-up no longer gets silently
    // dropped: it patches the already-open roster's SLG-derived bits (border/troop-count/team-tag)
    // in place instead of redrawing the whole screen.)
    const token = platform.storage.getItem(TOKEN_KEY);
    if (online && token) {
      const worldApi = new WorldApiClient(platform.storage);
      let opened = false;
      let view: CardRosterView | null = null;
      const openNow = (): void => { if (!opened) { opened = true; view = openRoster(); } };
      const giveUp = setTimeout(openNow, CARD_ROSTER_SLG_BUDGET_MS);
      resolveWorldShard(worldApi, (worldId) => {
        Promise.all([worldApi.getMe(worldId), worldApi.getTeams(worldId)])
          .then(([me, teams]) => {
            liveCardState = me.cardState;
            liveTeamNames = Object.fromEntries(teams.map((tt) => [tt.id, teamDisplayName(tt)]));
            if (!opened) { clearTimeout(giveUp); openNow(); }
            else view?.applyCardState();
          })
          .catch(() => { clearTimeout(giveUp); openNow(); });
      });
    } else {
      openRoster();
    }
  }

  /**
   * Equipment system (E5). Server-authoritative; requires an online login. Can be entered from
   * the campaign map (default back) or the roster ("Develop" tab); `back` determines where the
   * user returns to.
   *
   * `opts.overlay` mounts it on top of a still-live CardScene instead of replacing it (ADR-072) —
   * passed only by the roster's own two entries, whose `back` is a {@link AppViews.hideOverlay} pop.
   * The campaign-map entry keeps the plain full-scene swap: there is no roster underneath it to
   * preserve, and its `back` really does have to build one.
   */
  function goEquipment(
    back: () => void = goCampaignMap,
    group: 'none' | 'roster' = 'none',
    cardInstanceId = '',
    onSkins?: () => void,
    initialFilterSlot?: EquipSlot,
    opts?: MountOpts,
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
      ? { labelKey: 'roster.title' as TranslationKey, icon: 'rosterIcon' as IconKind, onSelect: () => back() }
      : undefined;
    const trailingPeers = group === 'roster' && onSkins
      ? [{ labelKey: 'roster.tab.skins' as TranslationKey, icon: 'skinIcon' as IconKind, onSelect: onSkins }]
      : undefined;
    views.showEquipment({
      onBack() { back(); },
      ...(peerTab ? { peerTab } : {}),
      ...(trailingPeers ? { trailingPeers } : {}),
      activeCardInstanceId: cardInstanceId,
      ...(initialFilterSlot ? { initialFilterSlot } : {}),
      getSave: () => saveManager.get(),
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      ...buildEquipmentActions(client, saveManager),
    }, opts);
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
        // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8), both win and loss — same
        // computeBadges the ResultScene renders. Local player is owner 0 in campaign.
        analytics.track('match_badges', {
          mode: 'campaign',
          result: winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw',
          level_id: levelId,
          ...matchBadgeTelemetry(stats[0]),
        });
        const outroTexts = winner === 0 && level.story?.outroKey ? [t(level.story.outroKey as TranslationKey)] : undefined;
        // Each chapter's last level (chN_lv10.json) carries a `realLayerKey` — the Tao/Anna
        // "real layer" beat for that chapter (world.md「章末真实层」). Shown as its own
        // illustrated interlude after the result panel, before actually returning to the map;
        // every other level (or a non-win) has no interlude, so `proceedToMap` is just
        // `goCampaignMap` (see resolveRealLayerInterlude's own unit tests for the branching).
        const interlude = resolveRealLayerInterlude(level, winner);
        const proceedToMap = interlude
          ? () => views.showRealLayerInterlude(interlude.illustrationUrl, interlude.textKey, {
              onFinish: () => goCampaignMap(),
            })
          : goCampaignMap;
        void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroTexts, proceedToMap, t('result.backToMap'));
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

  return { goGame, goCampaignMap, goLevelPrep, goCardRoster, goEquipment, goCampaign, goTutorial };
}
