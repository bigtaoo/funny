// Lobby navigation + social/achievement/retention/events red-dot refreshers. Extracted from createAppCore.
import * as analytics from '../../analytics';
import { t, type TranslationKey } from '../../i18n';
import { isFirstChapterCleared } from '../../game/campaign/progress';
import { hasClaimable, reachedTierKeys } from '../../game/meta/achievements';
import { getPvpUnlockedCards, validatePvpDeckClient, PVP_DECK_SIZE } from '../../game/meta/pvpLoadout';
import { WorldApiClient } from '../../net/WorldApiClient';
import { getWorldBaseUrl } from '../../net/config';
import type { LobbyView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import type { AIDifficulty } from '../../game';
import { TOKEN_KEY, LAST_SEEN_SEASON_KEY, TUTORIAL_DONE_FLAG } from '../appConstants';

/**
 * Roll an AI level (1–10, engine AISystem.ts) for a manually-started practice match,
 * scaled to the player's own ladder ELO. Mirrors server/shared/src/ladder.ts's
 * pickBotDifficulty(elo) / BOT_ELO_THRESHOLD (1200) — duplicated here (a 3-line formula)
 * rather than importing @nw/shared's ladder module, which the client webpack alias
 * intentionally scopes to the SLG-only browser-safe slice (see @nw/shared alias comment
 * in webpack.config.js). Keep the threshold/split in sync with ladder.ts if either changes.
 */
function pickPracticeDifficulty(elo: number): AIDifficulty {
  const roll = elo < 1200 ? 1 + Math.floor(Math.random() * 6) : 5 + Math.floor(Math.random() * 6);
  return roll as AIDifficulty;
}

export function createLobbyNav(ctx: AppCtx): Pick<Nav, 'goLobby'> {
  const { api, saveManager, platform, views, state, nav, getNetSession, playerName, avatarId } = ctx;

  /** Re-fetch the authoritative social badge total and push it into the lobby. */
  async function refreshSocialBadge(view: LobbyView): Promise<void> {
    if (!api || state.offlineMode || !platform.storage.getItem(TOKEN_KEY)) return;
    try {
      const b = await api.getSocialBadges();
      state.socialBadgeTotal = b.total;
      view.applySocialBadge(b.total);
    } catch { /* best-effort red dot — leave the cached value in place */ }
  }

  /** Re-fetch achievements and push the "any tier claimable" dot into the lobby (best-effort). */
  async function refreshAchievementBadge(view: LobbyView): Promise<void> {
    if (!api || state.offlineMode || !platform.storage.getItem(TOKEN_KEY)) return;
    try {
      const d = await api.getAchievements();
      state.achievementClaimable = hasClaimable(d.defs, d.stats, d.achievements);
      view.applyAchievementBadge(state.achievementClaimable);

      // S9-5b: diff reached tiers vs the baseline → one aggregated "unlocked" toast (§7).
      const reached = reachedTierKeys(d.defs, d.stats);
      if (state.achievementReached !== null) {
        const freshIds = new Set<string>();
        reached.forEach((k) => {
          if (!state.achievementReached!.has(k)) freshIds.add(k.slice(0, k.lastIndexOf('#')));
        });
        if (freshIds.size > 0) {
          const msg = freshIds.size === 1
            ? t('achievement.unlockToast', {
                name: t(('achievement.' + [...freshIds][0] + '.name') as TranslationKey),
              })
            : t('achievement.unlockToastMulti', { n: freshIds.size });
          view.showAchievementToast(msg);
          analytics.track('achievement_unlock_toast', { count: freshIds.size });
        }
      }
      state.achievementReached = reached;
    } catch { /* best-effort red dot — leave the cached value in place */ }
  }

  /** Re-fetch retention claimable state and push the daily red dot into the lobby (B5, best-effort). */
  async function refreshRetentionBadge(view: LobbyView): Promise<void> {
    if (!api || state.offlineMode || !platform.storage.getItem(TOKEN_KEY)) { view.applyRetentionBadge(false); return; }
    try {
      const r = await api.getRetention();
      view.applyRetentionBadge(r.claimable.checkin || r.claimable.daily);
    } catch { /* leave the dot off on failure */ }
  }

  /** Probe for an active event window so the events entry only appears when there's something to show (B6, best-effort). */
  async function refreshEventsAvailable(view: LobbyView): Promise<void> {
    if (!api || state.offlineMode || !platform.storage.getItem(TOKEN_KEY)) { view.applyEventsAvailable(false); return; }
    try {
      const events = await api.getEvents();
      view.applyEventsAvailable(events.length > 0);
    } catch { /* leave the entry hidden on failure */ }
  }

  function goLobby(opts?: { offline?: boolean; fromResize?: boolean }): void {
    // FTUE step ⑤: on the first lobby entry of this session, redirect to the dedicated tutorial
    // level if it has not been completed (ONBOARDING_DESIGN §2).
    // One-shot gate — subsequent returns to the lobby from child scenes do not re-trigger; resize redraws skip it too.
    if (!state.firstLobbyHandled && !opts?.fromResize) {
      state.firstLobbyHandled = true;
      if (!saveManager.getFlag(TUTORIAL_DONE_FLAG)) {
        if (opts?.offline !== undefined) state.offlineMode = opts.offline;
        nav.goTutorial();
        return;
      }
    }
    if (opts?.offline !== undefined) state.offlineMode = opts.offline;
    state.inLobby = true;
    platform.onGameplayStop();
    if (!opts?.fromResize) analytics.track('screen_view', { scene: 'LobbyScene' });
    const pvp = saveManager.get().pvp;
    const loggedIn = !state.offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const online = loggedIn && !!api && !!state.gatewayUrl;
    // First-time feature guide (ONBOARDING_DESIGN §4.1): if a feature's guide has not been seen,
    // show a dismissible guide card in the lobby before navigating; if already seen, navigate directly.
    // Covers all major lobby-reachable features (auction is inside the world map; each page's "?" button
    // re-shows the same guide using guide.* i18n + showFeatureGuide).
    function withGuide(featureId: string, titleKey: TranslationKey, bodyKey: TranslationKey, navFn: () => void): void {
      if (saveManager.featSeen(featureId)) { navFn(); return; }
      saveManager.markFeatSeen(featureId);
      lobby.showFeatureGuide(titleKey, bodyKey, navFn);
    }
    const lobby = views.showLobby({
      onStartGame(_opponentName: string) {
        withGuide('match', 'guide.match.title', 'guide.match.body', () => {
          nav.goGame({ difficulty: pickPracticeDifficulty(saveManager.get().pvp.elo) });
        });
      },
      onStartRanked() {
        // Below the first unlock tier the player's whole pool equals PVP_DECK_SIZE —
        // there is nothing to choose, so skip straight to matching instead of showing
        // an empty-looking builder with every card forced-selected.
        // Unlock is gated on *current* elo, not seasonPeakElo — a player who peaked high then
        // dropped must not keep high-tier units when matched against low-elo opponents.
        const save = saveManager.get();
        const elo = save.pvp.elo;
        const unlocked = getPvpUnlockedCards(elo);
        if (unlocked.length <= PVP_DECK_SIZE) {
          if (!save.pvpDeck || validatePvpDeckClient(save.pvpDeck, elo) !== null) {
            saveManager.patchLocal({ pvpDeck: unlocked });
          }
          nav.goRoom({ autoRanked: true });
        } else {
          nav.goDeckBuilder(() => nav.goRoom({ autoRanked: true }));
        }
      },
      online,
      onOpenCampaign() { nav.goCampaignMap(); },
      onOpenRoom() { nav.goRoom(); },
      onOpenSocial() { withGuide('social', 'guide.social.title', 'guide.social.body', () => nav.goFriends()); },
      ...(online ? { onOpenMail: () => nav.goMail() } : {}),
      onOpenShop() { withGuide('shop', 'guide.shop.title', 'guide.shop.body', () => nav.goGacha({})); },
      ...(online ? { onOpenRecharge: () => nav.goShop(goLobby, 'coins') } : {}),
      ...(online ? { onOpenLeaderboard: () => nav.goLeaderboard(goLobby) } : {}),
      // Lobby "cards" slot → Hero Roster (CHARACTER_CARDS_DESIGN §10). Roster mutations (feed/lock)
      // are server-authoritative, so logged-out / offline falls back to the offline-capable Collection
      // (card codex + skins wardrobe), which stays reachable from the campaign map too.
      onOpenCards() { withGuide('cards', 'guide.cards.title', 'guide.cards.body', () => (api ? nav.goCardRoster(goLobby) : nav.goCollection(goLobby, 'cards'))); },
      onOpenStats() { nav.goStats(); },
      ...(online ? { onOpenAchievements: () => nav.goAchievements() } : {}),
      ...(online ? { onOpenDaily: () => withGuide('daily', 'guide.daily.title', 'guide.daily.body', () => nav.goDaily()), onOpenEvents: () => nav.goEvents() } : {}),
      onOpenWorld() { withGuide('world', 'guide.world.title', 'guide.world.body', () => nav.goWorldEntry()); },
      ...(online ? { onOpenAuction: () => withGuide('auction', 'guide.auction.title', 'guide.auction.body', () => nav.goAuctionFromLobby()) } : {}),
      // SLG soft gate (ONBOARDING_DESIGN §4): grayed out with a tooltip bubble until the first chapter is cleared — the only feature gate.
      worldLocked: !isFirstChapterCleared(new Set(saveManager.get().progress.cleared)),
      onOpenProfile() { nav.goSettings(); },
      playerName: playerName(),
      avatarId: avatarId(),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      coins: saveManager.get().wallet.coins,
      offline: state.offlineMode,
      onLogin: () => nav.goLogin(),
      onLogout: loggedIn ? () => nav.doLogout() : undefined,
    });

    // Season settlement popup (SE-6): detect first lobby entry after a season transition.
    // Store and compare pvp.seasonNo in localStorage so it survives restarts.
    if (!opts?.fromResize && (pvp.seasonNo ?? 1) > 0) {
      const lastSeen = parseInt(platform.storage.getItem(LAST_SEEN_SEASON_KEY) ?? '0', 10);
      const currentSeason = pvp.seasonNo ?? 1;
      if (lastSeen > 0 && currentSeason > lastSeen) {
        // Season transitioned — show the settlement overlay once.
        const peakRank = pvp.seasonPeakRank ?? pvp.rank;
        lobby.showSeasonSettlement(lastSeen, peakRank, currentSeason);
      }
      platform.storage.setItem(LAST_SEEN_SEASON_KEY, String(currentSeason));
    }

    // Paint the cached social total immediately so the dot survives a resize
    // rebuild without flicker; then refresh from the server (skip on resize).
    lobby.applySocialBadge(state.socialBadgeTotal);
    lobby.applyAchievementBadge(state.achievementClaimable);
    // Ping worldsvc so the world-map nav button shows a "×" badge immediately when
    // the service isn't running — visible feedback before the user clicks the button.
    if (getWorldBaseUrl()) {
      const worldHealthApi = new WorldApiClient(platform.storage);
      void worldHealthApi.checkHealth().then((ok) => { if (state.inLobby) lobby.applyWorldAvailable(ok); });
    }
    if (online) {
      // Keep the gateway connected while idling in the lobby so presence + live
      // social pushes (request / chat / mail) update the red dot in real time.
      const onSocialPush = (): void => { void refreshSocialBadge(lobby); };
      const session = getNetSession();
      if (session) {
        session.handlers = {
          onMatchStart: (info) => nav.goGameNet(info),
          onFriendRequest: onSocialPush,
          onFriendUpdate:  onSocialPush,
          onChatMessage:   onSocialPush,
          onMailNew:       onSocialPush,
        };
        session.connect();
      }
      if (!opts?.fromResize) void refreshSocialBadge(lobby);
      if (!opts?.fromResize) void refreshAchievementBadge(lobby);
      if (!opts?.fromResize) void refreshRetentionBadge(lobby);
      if (!opts?.fromResize) void refreshEventsAvailable(lobby);
    } else {
      state.socialBadgeTotal = 0;
      state.achievementClaimable = false;
      state.achievementReached = null; // drop the unlock baseline so a later login re-seeds without a stale toast
    }
  }

  return { goLobby };
}
