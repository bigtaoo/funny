// Result screen, replay playback, state-replay share/deep-link, and the online netplay match loop.
// Extracted from createAppCore.
import * as analytics from '../../analytics';
import { createGameEngine, RecordingInputSource, ENGINE_VERSION, achievementStatDelta } from '../../game';
import type { OwnerId, PlayerStats, Replay, MatchStartInfo } from '../../game';
import { matchStateHash } from '../../net/judgeRunner';
import { MatchMode } from '../../net/proto/transport';
import { stateRecorder } from '../../game/replay/StateRecorder';
import { decodeStateReplay, type EncodedStateReplay } from '../../game/replay/StateReplay';
import { ApiError } from '../../net/ApiClient';
import { t } from '../../i18n';
import { showToastMessage } from '../../net/log';
import type { EloResult } from '../../scenes/ResultScene';
import type { ProfileData } from '../../render/ProfilePopup';
import type { NetGameView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import { log, PLAYER_PUBLIC_ID_KEY } from '../appConstants';

type ResultNav = Pick<Nav, 'goResult' | 'goReplay' | 'goStatePlayer' | 'goGameNet'>;

export function createResultNav(ctx: AppCtx): ResultNav {
  const { api, saveManager, platform, state, views, nav, keepReplay, playerName } = ctx;

  function goReplay(replay: Replay, onExit: () => void = () => nav.goLobby()): void {
    state.inLobby = false;
    platform.onGameplayStart();
    views.showReplay(replay, {
      onExit() { onExit(); },
      ...(api ? { onShare: () => void doShareReplay({ mode: replay.mode, winner: replay.meta?.winner }) } : {}),
    });
  }

  /**
   * Share the in-memory state-stream replay (REPLAY_SHARE_DESIGN §4.3). Reads the {@link stateRecorder}
   * single slot → uploads to mint a share code → platform share (Web copy-link / WeChat card).
   * No engine re-run, no server re-evaluation. Requires api (online).
   */
  async function doShareReplay(overrides: { mode?: string; winner?: number } = {}): Promise<void> {
    if (!api) return;
    const players = [
      { name: playerName(), side: 0 as const },
      { name: '', side: 1 as const },
    ];
    const enc = stateRecorder.build({ ...overrides, players });
    if (!enc) return;
    try {
      const { shareCode } = await api.createStateReplayShare(enc);
      const res = await platform.shareReplay(shareCode, t('share.title'));
      // Confirm the outcome so the button never feels dead (the previous silent success was the bug).
      // native / card: the OS share sheet or WeChat card is its own confirmation → no toast.
      if (res.method === 'clipboard') showToastMessage(t('share.copied'), 'success');
      else if (res.method === 'manual') showToastMessage(t('share.manual'), 'success');
    } catch (e) {
      // Classify share failures by cause so the player gets an actionable message. The two most common
      // reasons: payload too large (this match was too long, still exceeds the limit after compression)
      // / minting rate-limited (too many shares in a short window). All others are treated as network / unknown.
      const code = e instanceof ApiError ? e.code : null;
      const reason =
        code === 'BAD_REQUEST' ? 'too_large' : code === 'RATE_LIMITED' ? 'rate_limited' : 'error';
      log.error('state replay share failed', { reason, err: String(e) });
      const key =
        reason === 'too_large' ? 'share.errTooLarge'
        : reason === 'rate_limited' ? 'share.errRateLimited'
        : 'share.errGeneric';
      showToastMessage(t(key));
    }
  }

  /**
   * Deep-link to the mute state player without login (REPLAY_SHARE_DESIGN §4.1): anonymously fetch
   * the blob by share code → decode → enter StatePlayerScene. On failure (not found / expired /
   * network error) fall back to the login screen (which includes a play-demo entry).
   */
  async function goStatePlayer(shareCode: string): Promise<void> {
    state.inLobby = false;
    if (!api) { nav.goLogin(); return; }
    try {
      const { blob } = await api.getStateReplayShare(shareCode);
      const enc = blob as EncodedStateReplay;
      const replay = decodeStateReplay(enc);
      platform.onGameplayStart();
      views.showStatePlayer(
        replay,
        {
          onPlayDemo() { nav.goLobby({ offline: !api }); },
          onBackToLogin() { nav.goLogin(); },
        },
        enc,
      );
    } catch (e) {
      log.error('open shared state replay failed', { err: String(e) });
      nav.goLogin();
    }
  }

  function goGameNet(info: MatchStartInfo): void {
    const session = state.netSession;
    if (!session) { nav.goLobby(); return; }
    state.inLobby = false;
    platform.onGameplayStart();
    const isRankedMode = info.mode === MatchMode.RANKED;
    analytics.track('pvp_match_start', { mode: isRankedMode ? 'ranked' : 'friendly' });
    analytics.track('game_start', { mode: isRankedMode ? 'pvp_ranked' : 'pvp_friendly' });
    const netGameStartTs = Date.now();

    const localOwner = info.localSide as OwnerId;

    const localPvp = saveManager.get().pvp;
    const oppProfile: ProfileData = {
      name: info.opponentName,
      publicId: info.opponentPublicId,
      ...(info.opponentTitle ? { equippedTitle: info.opponentTitle } : {}),
    };
    const localProfile: ProfileData = {
      name: playerName(),
      publicId: platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
      rankKey: localPvp.rank,
      elo: localPvp.elo,
      isSelf: true,
    };
    const profiles = { opponent: oppProfile, local: localProfile };

    const recorder = new RecordingInputSource(session.input);
    const engine = createGameEngine(
      {
        seed: info.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'netplay',
        ...(info.decks ? { decks: { top: info.decks.top, bottom: info.decks.bottom } } : {}),
      },
      recorder,
    );
    // Owner-indexed display names for the replay player (bottom = owner 0, top = owner 1).
    const replayPlayers = {
      bottom: localOwner === 0 ? playerName() : info.opponentName,
      top:    localOwner === 0 ? info.opponentName : playerName(),
    };
    const buildNetReplay = (winner: OwnerId | null): Replay =>
      recorder.snapshot({
        seed: info.seed,
        mode: 'netplay',
        ...(info.decks ? { decks: { top: info.decks.top, bottom: info.decks.bottom } } : {}),
        meta: { recordedAt: Date.now(), winner: winner ?? -1, players: replayPlayers },
      });

    const isRanked = isRankedMode;
    let netResultShown = false;
    let lastElo: EloResult | undefined;
    let pending: { winner: OwnerId | null; stats: [PlayerStats, PlayerStats]; replay?: Replay } | null = null;
    let eloWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finishNet = (
      winner: OwnerId | null,
      stats: [PlayerStats, PlayerStats],
      elo?: EloResult,
      replay?: Replay,
    ): void => {
      if (netResultShown) return;
      netResultShown = true;
      if (eloWaitTimer) { clearTimeout(eloWaitTimer); eloWaitTimer = null; }
      if (isRanked) void saveManager.refresh();
      // Ranked: "play again" re-enters the ranked queue (fresh session), and a
      // secondary "back to lobby" gives an explicit exit. Friendly/AI keep the
      // default (play again == back to lobby), so no extra lobby button there.
      const onPlayAgain = isRanked
        ? () => { session.close(); state.netSession = null; nav.goRoom({ autoRanked: true }); }
        : undefined;
      const onReturnToLobby = isRanked
        ? () => { session.close(); state.netSession = null; nav.goLobby({ fade: true }); } // exiting a match
        : undefined;
      void nav.goResult(
        winner, stats, localOwner, keepReplay(replay), elo, profiles,
        undefined, onPlayAgain, undefined, onReturnToLobby,
      );
    };

    const view: NetGameView = views.showGameNet(localOwner, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S9-6: attach local-side per-match achievement counters (kill.*/cast.*). Meta accumulates only in ranked + L1 verification; friendly matches are ignored.
        session.reportResult(matchStateHash(winner, stats), winner ?? 0, achievementStatDelta(stats[localOwner]));
        const replay = buildNetReplay(winner);
        const result = winner === null ? 'draw' : winner === localOwner ? 'win' : 'loss';
        analytics.track('game_end', {
          mode: isRanked ? 'pvp_ranked' : 'pvp_friendly',
          result,
          duration_sec: Math.round((Date.now() - netGameStartTs) / 1000),
        });
        if (isRanked) {
          pending = { winner, stats, replay };
          eloWaitTimer = setTimeout(() => finishNet(winner, stats, lastElo, replay), 6000);
        } else {
          finishNet(winner, stats, undefined, replay);
        }
      },
      onNetMatchOver(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        finishNet(winner, stats, lastElo, buildNetReplay(winner));
      },
      onExitToLobby() {
        analytics.track('game_end', { mode: isRanked ? 'pvp_ranked' : 'pvp_friendly', result: 'abandon', duration_sec: Math.round((Date.now() - netGameStartTs) / 1000) });
        session.close(); nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
    }, { engine, net: true, profiles });

    session.handlers = {
      onMatchStart: (i) => goGameNet(i),
      onNetState:   (s) => view.applyNetState(s),
      onPeerDc:     (p) => view.applyPeerDc(p),
      onMatchOver:  (m) => {
        lastElo = m.elo ? { delta: m.elo.delta, after: m.elo.after, rankAfter: m.elo.rankAfter } : undefined;
        view.applyMatchOver(m);
        if (pending) finishNet(pending.winner, pending.stats, lastElo, pending.replay);
      },
    };
  }

  async function goResult(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    localOwner: OwnerId = 0,
    replay?: Replay,
    elo?: EloResult,
    profiles?: { opponent?: ProfileData; local?: ProfileData },
    outroText?: string,
    onPlayAgain?: () => void,
    playAgainLabel?: string,
    onReturnToLobby?: () => void,
  ): Promise<void> {
    state.inLobby = false;
    platform.onGameplayStop();
    analytics.track('screen_view', { scene: 'ResultScene' });
    await platform.showMidgameAd();
    views.showResult({
      winner,
      stats,
      localOwner,
      ...(elo ? { elo } : {}),
      ...(profiles ? { profiles } : {}),
      ...(outroText ? { outroText } : {}),
      cb: {
        // Falling through to the lobby (no dedicated "play again") is leaving the match — fades.
        onPlayAgain() { (onPlayAgain ?? (() => nav.goLobby({ fade: true })))(); },
        // Top-left back chip always exits to the lobby, even when onPlayAgain re-enters a
        // match instead. Reuses onReturnToLobby's session-teardown when the caller supplied
        // one (e.g. ranked's session.close()); otherwise a plain lobby nav is correct. Either
        // way this leaves the match, so it fades.
        onBack() { (onReturnToLobby ?? (() => nav.goLobby({ fade: true })))(); },
        ...(replay ? { onWatchReplay: () => goReplay(replay) } : {}),
        ...(api ? { onShare: () => void doShareReplay({ winner: winner ?? -1 }) } : {}),
        ...(playAgainLabel ? { playAgainLabel } : {}),
      },
    });
  }

  return { goResult, goReplay, goStatePlayer, goGameNet };
}
