// matchsvc — the private matchmaking brain unreachable by players (M17); a standalone process since
// 2026-06-14 (S1-M5). Player actions are decoded by the gateway and forwarded to this process via
// internal HTTP (internalHttp.ts → methods of this class); async events are pushed back to the
// gateway via the injected push callback (GatewayClient HTTP), and the gateway forwards them to
// the player socket.
//
// Responsibilities (SERVER_API.md §8.1 / MATCHSVC_DESIGN.md §2):
//   • friendly in-memory rooms (create / join by code / ready / host starts);
//   • ranked match queue (ELO proximity pairing, ported from gameserver Matchmaking);
//   • game registry (which gameserver has capacity) + signs match tickets after pairing / start;
//   • async events (room state changes / match_found) pushed back to gateway → player via the
//     injected push callback.
//
// **No database connections**: the ELO value needed for matchmaking is fetched by the gateway from
// meta before enqueuing and passed in as the `elo` parameter to enqueue.
import { randomUUID, randomInt } from 'crypto';
import { signTicket, createLogger, type FeatureFlagCache, type TicketClaims } from '@nw/shared';
import { Matchmaking, type QueueEntry } from './Matchmaking';
import { GameRegistry } from './GameRegistry';

const log = createLogger('matchsvc');

// RoomPhase enum values mirror contracts/transport.proto (encoding is the gateway's responsibility;
// matchsvc only passes through the integer phase).
const RoomPhase = {
  WAITING: 0,
  READY: 1,
  COUNTDOWN: 2,
  IN_MATCH: 3,
  OVER: 4,
} as const;

// ── Gateway push interface (matchsvc holds no connections directly; proto-agnostic) ────────────────
export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 9-digit numeric public id (used for player communication / reports; defaults to empty string). */
  publicId: string;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  // Match timeout fallback to AI (feature flag match_bot_fallback). Client opens a local AI match; no ticket/gameUrl.
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string };

/** Display names randomly picked for the AI opponent during bot-fallback (display only; narrative voice unified as the "red-pen corrector / imaginary rival" theme). */
const BOT_NAMES = ['Red Pen Cadet', 'Draft Paper Recruit', 'Eraser Apprentice', 'Sticky Note Trainee', 'Correction Fluid Guard'];
/**
 * Push callback. `roomId` is a cross-process correlation id — it is included in logs across
 * matchsvc / gateway / game / meta for the same match, so Grafana can reconstruct the full
 * match timeline with `| json | roomId="X"`. Used for logging only; not included in the
 * client-visible PushMsg. Omitted when there is no room context (e.g. ALREADY_IN_ROOM errors).
 */
export type Push = (accountId: string, msg: PushMsg, roomId?: string) => void;

interface Slot {
  accountId: string;
  name: string;
  publicId: string;
  /** Equipped title id (from meta /internal/profile; empty string = no title). */
  equippedTitle: string;
  /** PvP deck (card ids; validated and resolved by gateway; empty = engine uses defaultPvpDeck). */
  deck: string[];
  side: 0 | 1;
  ready: boolean;
  connected: boolean;
}
interface Room {
  roomId: string;
  code: string;
  slots: Slot[];
  phase: number;
  /** Timer that cleans up the room after all players disconnect. */
  reapTimer: NodeJS.Timeout | null;
}

// MUST stay identical to client RoomScene.ts (its keypad can only type these
// chars). 10 digits + 11 letters; letters skip I/O/L so they don't read as 0/1.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
const CODE_LEN = 6;
const REAP_MS = 60_000; // grace period to keep the room after all players disconnect

export interface MatchsvcOpts {
  ticketTtlSec?: number;
  /** Injected clock (for testing). */
  now?: () => number;
  /** Matchmaking auto-tick switch (disable in tests to tick manually). */
  autoTick?: boolean;
  /** Feature flag cache (polls admin for raw rules + evaluates locally). Absent = unavailable; match_bot_fallback treated as off. */
  flags?: FeatureFlagCache;
  /** If a player has been queued for longer than this many milliseconds, evaluate match_bot_fallback to decide whether to fall back to an AI match. Defaults to 30000. */
  botFallbackMs?: number;
}

export class Matchsvc {
  private readonly rooms = new Map<string, Room>(); // roomId → room
  private readonly byCode = new Map<string, string>(); // code → roomId
  private readonly accountRoom = new Map<string, string>(); // accountId → roomId
  private readonly matchmaking: Matchmaking;
  private readonly internalKey: string;
  private readonly ticketTtlSec: number;
  private readonly now: () => number;
  private readonly flags?: FeatureFlagCache;

  constructor(
    private readonly push: Push,
    private readonly games: GameRegistry,
    internalKey: string,
    opts: MatchsvcOpts = {},
  ) {
    this.internalKey = internalKey;
    this.ticketTtlSec = opts.ticketTtlSec ?? 30;
    this.now = opts.now ?? Date.now;
    if (opts.flags) this.flags = opts.flags;
    this.matchmaking = new Matchmaking((a, b) => this.onPair(a, b), {
      now: opts.now,
      autoTick: opts.autoTick,
      botFallbackMs: opts.botFallbackMs ?? 30_000,
      onTimeout: (e) => this.onQueueTimeout(e),
    });
  }

  /**
   * Real-time aggregate (admin GET /internal/stats, OPS_DESIGN §4.1): ranked queue length /
   * active friendly room count / healthy game instance count / total game load.
   */
  stats(): { queue: number; rooms: number; gameInstances: number; gameLoad: number } {
    const g = this.games.stats();
    return {
      queue: this.matchmaking.size,
      rooms: this.rooms.size,
      gameInstances: g.instances,
      gameLoad: g.load,
    };
  }

  // ───────────────────────── ranked matchmaking ─────────────────────────

  /**
   * Start ranked matchmaking (elo is fetched by the gateway from meta and passed in). Ignored if
   * the player is already in a room or queue. publicId is carried with the queue entry: ranked
   * matches don't show room slots, but after the match starts the opponent's publicId must be
   * written into the ticket → match_start for the in-game profile popup.
   */
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', platform = '', deck: string[] = []): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      log.warn('enqueue ignored: already in room/queue', { accountId });
      return;
    }
    this.matchmaking.enqueue(accountId, name, publicId, elo, equippedTitle, platform, deck);
    log.info('enqueued for ranked', { accountId, elo, queueSize: this.matchmaking.size });
  }

  cancel(accountId: string): void {
    this.matchmaking.remove(accountId);
  }

  /**
   * Decision point when a player has waited beyond the threshold (default 30s): if feature flag
   * `match_bot_fallback` is enabled for this player, dequeue and push match_bot (client opens a
   * local AI match); otherwise keep in queue waiting for a human opponent (no behaviour change).
   * If flags is absent or admin is unreachable, treated as off (default false), gracefully
   * degrading to "keep waiting indefinitely".
   */
  private onQueueTimeout(entry: QueueEntry): void {
    const on =
      this.flags?.isOn('match_bot_fallback', {
        accountId: entry.accountId,
        ...(entry.platform ? { platform: entry.platform as never } : {}),
      }) ?? false;
    if (!on) {
      log.info('queue timeout: bot fallback OFF → keep waiting for human', { accountId: entry.accountId });
      return;
    }
    this.matchmaking.remove(entry.accountId);
    const seed = randomInt(1, 2 ** 48);
    const opponentName = BOT_NAMES[randomInt(0, BOT_NAMES.length)]!;
    log.info('queue timeout: bot fallback ON → match_bot', { accountId: entry.accountId, elo: entry.elo, seed });
    this.push(entry.accountId, { kind: 'match_bot', seed, opponentName, elo: entry.elo, difficulty: 'normal' });
  }

  /** Matchmaking pair found → start the match immediately (no ready / host step). */
  private onPair(a: QueueEntry, b: QueueEntry): void {
    log.info('ranked pair matched', { a: a.accountId, b: b.accountId, eloA: a.elo, eloB: b.elo });
    this.startMatch(
      'ranked',
      { accountId: a.accountId, name: a.name, publicId: a.publicId, equippedTitle: a.equippedTitle, deck: a.deck },
      { accountId: b.accountId, name: b.name, publicId: b.publicId, equippedTitle: b.equippedTitle, deck: b.deck },
    );
  }

  // ───────────────────────── friendly rooms ─────────────────────────

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = '', deck: string[] = []): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = this.uniqueCode();
    const roomId = randomUUID();
    const room: Room = {
      roomId,
      code,
      slots: [{ accountId, name, publicId, equippedTitle, deck, side: 0, ready: false, connected: true }],
      phase: RoomPhase.WAITING,
      reapTimer: null,
    };
    this.rooms.set(roomId, room);
    this.byCode.set(code, roomId);
    this.accountRoom.set(accountId, roomId);
    log.info('room created', { accountId, code, roomId });
    this.broadcast(room);
  }

  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = '', deck: string[] = []): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const roomId = this.byCode.get(code.toUpperCase());
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) {
      log.warn('join failed: room not found', { accountId, code });
      this.push(accountId, { kind: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no such room' });
      return;
    }
    if (room.slots.length >= 2) {
      log.warn('join failed: room full', { accountId, code });
      this.push(accountId, { kind: 'room_error', code: 'ROOM_FULL', message: 'room is full' });
      return;
    }
    room.slots.push({ accountId, name, publicId, equippedTitle, deck, side: 1, ready: false, connected: true });
    this.accountRoom.set(accountId, room.roomId);
    log.info('room joined', { accountId, code, roomId: room.roomId });
    this.broadcast(room);
  }

  roomReady(accountId: string, ready: boolean): void {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.ready = ready;
    const allReady = room.slots.length === 2 && room.slots.every((s) => s.ready);
    room.phase = allReady ? RoomPhase.READY : RoomPhase.WAITING;
    this.broadcast(room);

    // Both players ready → start automatically. Previously this only flipped the
    // phase to READY and waited for the host to press "start", which players read
    // as the game failing to start. Auto-start (like ranked) removes that gap.
    if (allReady) {
      const [s0, s1] = room.slots;
      this.destroyRoom(room); // lobby room's job done; match state is now owned by gameserver
      this.startMatch(
        'friendly',
        { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, deck: s0!.deck },
        { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, deck: s1!.deck },
      );
    }
  }

  /**
   * Host (side 0) starts the match after both players are ready. Both-ready now auto-starts via
   * {@link roomReady}; this entry point is kept for backwards compatibility with older clients that
   * send an explicit start button press (the room will already be destroyed at that point →
   * roomOf returns undefined → no-op).
   */
  roomStart(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const host = room.slots.find((s) => s.side === 0);
    if (!host || host.accountId !== accountId) return;
    if (room.slots.length !== 2 || !room.slots.every((s) => s.ready)) return;

    const [s0, s1] = room.slots;
    this.destroyRoom(room); // lobby room's job done; match state is now owned by gameserver
    this.startMatch(
      'friendly',
      { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, deck: s0!.deck },
      { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, deck: s1!.deck },
    );
  }

  /** Leave the room / cancel queuing. */
  roomLeave(accountId: string): void {
    this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    this.removeFromRoom(room, accountId);
  }

  // ───────────────────────── Connection lifecycle (gateway notifications) ─────────────────────────

  /** Account (re-)connected to gateway: if in a room, re-send the current room_state to it (control-plane reconnect resumption). */
  onConnected(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (slot && !slot.connected) {
      slot.connected = true;
      if (room.reapTimer) {
        clearTimeout(room.reapTimer);
        room.reapTimer = null;
      }
      this.broadcast(room);
    } else {
      this.pushRoomState(accountId, room); // resend only to this player
    }
  }

  /** Account disconnected from gateway: remove from queue; if in a lobby room mark as disconnected (retain within grace period to support control-plane reconnect). */
  onDisconnected(accountId: string): void {
    this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.connected = false;
    this.broadcast(room);
    if (room.slots.every((s) => !s.connected)) {
      room.reapTimer = setTimeout(() => this.destroyRoom(room), REAP_MS);
      room.reapTimer.unref?.();
    }
  }

  // ───────────────────────── game registry ─────────────────────────

  registerGame(gameId: string, wsUrl: string, capacity: number): void {
    log.info('game server registered', { gameId, wsUrl, capacity });
    this.games.register(gameId, wsUrl, capacity);
  }
  gameHeartbeat(gameId: string, load: number, rooms: number): void {
    this.games.heartbeat(gameId, load, rooms);
  }

  // ───────────────────────── Start match + sign ticket ─────────────────────────

  private startMatch(
    mode: 'friendly' | 'ranked',
    a: { accountId: string; name: string; publicId: string; equippedTitle: string; deck: string[] },
    b: { accountId: string; name: string; publicId: string; equippedTitle: string; deck: string[] },
  ): void {
    const gameUrl = this.games.pick();
    if (!gameUrl) {
      log.error('startMatch aborted: no game server available (none registered + no fallback)', {
        a: a.accountId,
        b: b.accountId,
        mode,
      });
      const msg: PushMsg = { kind: 'room_error', code: 'GAME_UNAVAILABLE', message: 'no game server available' };
      this.push(a.accountId, msg);
      this.push(b.accountId, msg);
      return;
    }
    const roomId = randomUUID();
    const seed = randomInt(1, 2 ** 48); // < 2^48, within safe integer range
    // a = side 0 (top), b = side 1 (bottom) — both tickets carry both decks for deterministic engine construction.
    const decks = a.deck.length > 0 || b.deck.length > 0
      ? { top: a.deck, bottom: b.deck }
      : undefined;
    log.info('match starting', { mode, roomId, gameUrl, a: a.accountId, b: b.accountId, seed, hasDecks: !!decks });

    const sign = (
      self: { accountId: string; name: string; publicId: string; equippedTitle: string },
      opp: { accountId: string; name: string; publicId: string; equippedTitle: string },
      side: 0 | 1,
    ): string => {
      const claims: TicketClaims = {
        roomId,
        seed,
        side,
        mode,
        opponent: opp.name,
        opponentPublicId: opp.publicId,
        opponentTitle: opp.equippedTitle || undefined,
        gameUrl,
        accountId: self.accountId,
        ...(decks ? { decks } : {}),
      };
      return signTicket(claims, { key: this.internalKey, ttlSec: this.ticketTtlSec });
    };

    this.push(a.accountId, { kind: 'match_found', gameUrl, ticket: sign(a, b, 0) }, roomId);
    this.push(b.accountId, { kind: 'match_found', gameUrl, ticket: sign(b, a, 1) }, roomId);
  }

  // ───────────────────────── Internal ─────────────────────────

  private roomOf(accountId: string): Room | undefined {
    const id = this.accountRoom.get(accountId);
    return id ? this.rooms.get(id) : undefined;
  }

  private removeFromRoom(room: Room, accountId: string): void {
    room.slots = room.slots.filter((s) => s.accountId !== accountId);
    this.accountRoom.delete(accountId);
    if (room.slots.length === 0) {
      this.destroyRoom(room);
      return;
    }
    // Remaining player takes side 0 (host) and their ready flag is reset.
    room.slots[0]!.side = 0;
    room.slots[0]!.ready = false;
    room.phase = RoomPhase.WAITING;
    this.broadcast(room);
  }

  private destroyRoom(room: Room): void {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
    for (const s of room.slots) this.accountRoom.delete(s.accountId);
    this.byCode.delete(room.code);
    this.rooms.delete(room.roomId);
  }

  private playersView(room: Room): PlayerView[] {
    return room.slots.map((s) => ({
      side: s.side,
      name: s.name,
      ready: s.ready,
      connected: s.connected,
      publicId: s.publicId,
    }));
  }

  private pushRoomState(accountId: string, room: Room): void {
    this.push(
      accountId,
      { kind: 'room_state', code: room.code, players: this.playersView(room), phase: room.phase },
      room.roomId,
    );
  }

  private broadcast(room: Room): void {
    const players = this.playersView(room);
    for (const s of room.slots) {
      this.push(s.accountId, { kind: 'room_state', code: room.code, players, phase: room.phase }, room.roomId);
    }
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.byCode.has(code)) return code;
    }
    return CODE_ALPHABET[0]!.repeat(CODE_LEN - 4) + Date.now().toString(36).slice(-4).toUpperCase();
  }
}
