// PvP room + ranked queue + deck builder navigation. Extracted from createAppCore.
import * as analytics from '../../analytics';
import type { RoomView } from '../AppViews';
import type { AppCtx, Nav } from '../appCtx';
import type { AIDifficulty } from '../../game';
import { WorldApiClient } from '../../net/WorldApiClient';
import { log } from '../appConstants';
import type { RoomIntent } from '../../platform/IPlatform';
import { RoomPhase, type RoomState } from '../../net/proto/transport';
import { CODE_ALPHABET, CODE_LEN } from '../../scenes/RoomScene/types';

/** A room code as the server hands them out; anything else in an invite link is ignored. */
function isRoomCode(code: string): boolean {
  return code.length === CODE_LEN && [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Whether a friend could still take the second seat — what the platform's "join" button offers. */
function isJoinable(s: RoomState): boolean {
  return s.phase === RoomPhase.WAITING && s.players.length < 2;
}

/** Parse the server's decimal-string AI level (1–10, see AISystem.ts), or undefined if malformed. */
function parseAiDifficulty(raw: string): AIDifficulty | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? (n as AIDifficulty) : undefined;
}

export function createRoomNav(ctx: AppCtx): Pick<Nav, 'goRoom' | 'goDeckBuilder'> {
  const { api, saveManager, views, state, nav, getNetSession, resolvePvpDeck, platform } = ctx;
  const rooms = platform.rooms;
  /** The friend-room scene is on screen (an invite accepted now has to leave it first). */
  let roomSceneOpen = false;

  // An invite accepted while the game is running (CrazyGames: the portal's join button / invite
  // popup). In the room scene it replaces the current room; anywhere else it waits for the next
  // lobby entry — never pulling the player out of a match — and the lobby itself takes it now.
  rooms?.onJoinRequest((code) => {
    if (!isRoomCode(code)) return;
    const intent: RoomIntent = { kind: 'join', code };
    if (roomSceneOpen) {
      getNetSession()?.close();
      goRoom({ intent });
      return;
    }
    state.pendingRoomIntent = intent;
    if (state.inLobby) nav.goLobby();
  });

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

  function goRoom(opts?: { autoRanked?: boolean; intent?: RoomIntent }): void {
    state.inLobby = false;
    roomSceneOpen = true;
    const intent = opts?.intent?.kind === 'join' && !isRoomCode(opts.intent.code) ? undefined : opts?.intent;
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
    /** The code of the friend room this player sits in, as the platform was last told. */
    let roomCode: string | null = null;
    const leftRoom = (): void => { roomCode = null; rooms?.left(); };
    let intentStarted = false;
    const startIntent = (): void => {
      if (!intent || intentStarted) return;
      intentStarted = true;
      if (intent.kind === 'join') {
        analytics.track('pvp_room_join', { via: 'invite' });
        session?.joinRoom(intent.code, getSavedDeck());
      } else {
        analytics.track('pvp_room_create', { mode: 'friendly', via: 'invite' });
        session?.createRoom(getSavedDeck());
      }
    };
    const onOpen = (): void => {
      if (autoRanked) queueRanked();
      startIntent();
    };
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
      ...(intent && session ? { startIn: intent.kind } : {}),
      ...(rooms ? { inviteLink: (code: string) => rooms.inviteLink(code) } : {}),
      ...(worldApi ? { getProfileExtra: (publicId: string) => worldApi.getProfileExtra(publicId) } : {}),
      onBack() {
        roomSceneOpen = false;
        leftRoom();
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
        onMatchStart: (info) => {
          roomSceneOpen = false;
          // Still in the room, but its seats are taken: the platform stops offering "join".
          if (roomCode) rooms?.update(roomCode, false);
          nav.goGameNet(info);
        },
        // Matchmaking timeout fallback to AI (feature flag match_bot_fallback): server pushes match_bot →
        // exit the queue UI and start a local AI match (using the server-provided seed + AI level).
        onMatchBot: (seed, _opponentName, _elo, difficulty) => {
          // Wanted a human, got a bot. Silent to the player and, until now, silent in the data too —
          // yet "ranked is all bots" is exactly the kind of thing that empties a PvP mode.
          analytics.track('pvp_match_bot', { wait_sec: queueWaitSec(), difficulty });
          rankedQueued = false;
          queueStartTs = 0;
          roomSceneOpen = false;
          const level = parseAiDifficulty(difficulty);
          log.info('match_bot fallback → local AI match', { seed, difficulty: level });
          nav.goGame({ seed, ...(level !== undefined ? { difficulty: level } : {}), fromBotFallback: true });
        },
        onRoomState: (s) => {
          roomCode = s.code;
          rooms?.update(s.code, isJoinable(s));
          view.applyRoomState(s);
        },
        onRoomError: (e) => {
          analytics.track('pvp_room_error', { error: e.code });
          // A failed create/join leaves no room — unless one is already held (ALREADY_IN_ROOM after a
          // reload: the server re-sends that room's state, and the player is still sitting in it).
          if (!roomCode) leftRoom();
          view.applyRoomError(e);
        },
        onPeerDc:    (p) => view.applyPeerDc(p),
        onNetState:  (s) => {
          view.applyNetState(s);
          if (s === 'open') onOpen();
          if (s === 'disconnected') leftRoom();
        },
      };
      session.connect();
      // If the gateway was already open from the lobby phase, connect() is a no-op
      // and onNetState('open') will never fire — deliver it synchronously now.
      if (session.gateway.getState() === 'open') {
        view.applyNetState('open');
        onOpen();
      }
    }
  }

  return { goRoom, goDeckBuilder };
}
