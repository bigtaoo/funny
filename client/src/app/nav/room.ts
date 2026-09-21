// PvP room + ranked queue + deck builder navigation. Extracted from createAppCore.
import * as analytics from '../../analytics';
import type { RoomView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import type { AIDifficulty } from '../../game';
import { WorldApiClient } from '../../net/WorldApiClient';
import { log } from '../appConstants';

/** Parse the server's decimal-string AI level (1–10, see AISystem.ts), or undefined if malformed. */
function parseAiDifficulty(raw: string): AIDifficulty | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? (n as AIDifficulty) : undefined;
}

export function createRoomNav(ctx: AppCtx): Pick<Nav, 'goRoom' | 'goDeckBuilder'> {
  const { api, saveManager, views, state, nav, getNetSession, resolvePvpDeck, platform } = ctx;

  function goDeckBuilder(onSave: (deck: string[]) => void): void {
    const save = saveManager.get();
    views.showDeckBuilder({
      onSave(deck) {
        saveManager.patchLocal({ pvpDeck: deck });
        onSave(deck);
      },
      onBack() { nav.goLobby(); },
      getCurrentDeck() { return save.pvpDeck; },
      getCurrentElo() { return save.pvp.elo; },
    });
  }

  function goRoom(opts?: { autoRanked?: boolean }): void {
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'RoomScene', ranked: !!opts?.autoRanked });
    const session = getNetSession();
    const autoRanked = !!opts?.autoRanked && session !== null;
    if (opts?.autoRanked && session === null) {
      log.warn('autoRanked requested but no NetSession (offline / no gateway url)', {
        hasApi: !!api,
        gatewayUrl: state.gatewayUrl,
      });
    }
    const getSavedDeck = resolvePvpDeck;
    // Cheap/stateless (just wraps platform.storage) — profile popups fetch rank/ELO/family/sect
    // straight from socialsvc by publicId, same as the friends/family social surfaces.
    const worldApi = api ? new WorldApiClient(platform.storage) : null;
    let rankedQueued = false;
    // Wall-clock the player spends waiting, reported with whichever way the queue ends
    // (pvp_queue_cancel / pvp_match_bot). "How long before they give up" is the number that
    // decides the matchmaking timeout, and nothing measured it before 2026-09-20.
    let queueStartTs = 0;
    const queueWaitSec = (): number => (queueStartTs ? Math.round((Date.now() - queueStartTs) / 1000) : 0);
    const queueRanked = (): void => {
      if (rankedQueued) return;
      rankedQueued = true;
      queueStartTs = Date.now();
      log.info('entering ranked queue (createRanked)');
      analytics.track('pvp_room_create', { mode: 'ranked' });
      session?.createRanked(getSavedDeck());
    };
    const view: RoomView = views.showRoom({
      available: session !== null,
      autoRanked,
      ...(worldApi ? { getProfileExtra: (publicId: string) => worldApi.getProfileExtra(publicId) } : {}),
      onBack() {
        session?.close();
        if (session) session.handlers = { onMatchStart: (info) => nav.goGameNet(info) };
        nav.goLobby();
      },
      createRoom() { analytics.track('pvp_room_create', { mode: 'friendly' }); session?.createRoom(getSavedDeck()); },
      // Joining by friend code is its own funnel step: a wrong/expired code is a dead end the
      // player cannot distinguish from "the game is broken", and onRoomError below reports it.
      joinRoom(code: string) { analytics.track('pvp_room_join', {}); session?.joinRoom(code, getSavedDeck()); },
      setReady(ready: boolean) { session?.setReady(ready); },
      startMatch() { session?.startMatch(); },
      cancelQueue() {
        analytics.track('pvp_queue_cancel', { wait_sec: queueWaitSec() });
        rankedQueued = false;
        queueStartTs = 0;
        session?.cancelQueue();
      },
    });

    if (session) {
      session.handlers = {
        onMatchStart: (info) => nav.goGameNet(info),
        // Matchmaking timeout fallback to AI (feature flag match_bot_fallback): server pushes match_bot →
        // exit the queue UI and start a local AI match (using the server-provided seed + AI level).
        onMatchBot: (seed, _opponentName, _elo, difficulty) => {
          // Wanted a human, got a bot. Silent to the player and, until now, silent in the data too —
          // yet "ranked is all bots" is exactly the kind of thing that empties a PvP mode.
          analytics.track('pvp_match_bot', { wait_sec: queueWaitSec(), difficulty });
          rankedQueued = false;
          queueStartTs = 0;
          const level = parseAiDifficulty(difficulty);
          log.info('match_bot fallback → local AI match', { seed, difficulty: level });
          nav.goGame({ seed, ...(level !== undefined ? { difficulty: level } : {}), fromBotFallback: true });
        },
        onRoomState: (s) => view.applyRoomState(s),
        onRoomError: (e) => { analytics.track('pvp_room_error', { error: e.code }); view.applyRoomError(e); },
        onPeerDc:    (p) => view.applyPeerDc(p),
        onNetState:  (s) => {
          view.applyNetState(s);
          if (autoRanked && s === 'open') queueRanked();
        },
      };
      session.connect();
      // If the gateway was already open from the lobby phase, connect() is a no-op
      // and onNetState('open') will never fire — deliver it synchronously now.
      if (session.gateway.getState() === 'open') {
        view.applyNetState('open');
        if (autoRanked) queueRanked();
      }
    }
  }

  return { goRoom, goDeckBuilder };
}
