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
import { signTicket, createLogger, defaultPvpDeck, pickBotDifficulty, randomPlayerName, setActiveMatch, type FeatureFlagCache, type RedisLike, type TicketClaims } from '@nw/shared';
import { Matchmaking, type QueueEntry } from './Matchmaking';
import { GameRegistry } from './GameRegistry';
import {
  saveRoom,
  clearRoomAccount,
  deleteRoom,
  loadAllRooms,
  saveQueueEntry,
  deleteQueueEntry,
  loadAllQueueEntries,
  saveDuelInvite,
  deleteDuelInvite,
  loadAllDuelInvites,
} from './persist';

const log = createLogger('matchsvc');

// RoomPhase enum values mirror contracts/transport.proto (encoding is the gateway's responsibility;
// matchsvc only passes through the integer phase).
export const RoomPhase = {
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
  // `difficulty` is the AI level 1–10 (engine AISystem.ts) encoded as a decimal string —
  // kept as `string` on the wire (transport.proto field is string) to avoid a proto/codegen
  // change; parse with Number(...) on the receiving end. Rolled by pickBotDifficulty(elo).
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string }
  // Friend-challenge ("切磋") invite, pushed to the invited friend (gateway resolves their publicId
  // → accountId before calling duelInvite). Accepting skips straight to match_found (startMatch) —
  // there is no separate "duel accepted" push.
  | { kind: 'duel_invited'; inviteId: string; fromPublicId: string; fromName: string }
  // Pushed back to the inviter on the unhappy path only. reason: declined | timeout | offline | not_found | lost
  // (the middle two originate at the gateway, before a matchsvc invite record even exists; lost originates
  // at matchsvc rehydrate — see prematch_lost below).
  | { kind: 'duel_cancelled'; inviteId: string; reason: string }
  // ── matchsvc restart-safety (matchsvc-prematch-persist, 2026-07-29) ──────────
  // Pushed to every account whose pre-match state was rehydrated from Redis after a matchsvc restart
  // (see rehydrate.ts), instead of silently waiting for the client's own much-longer timeout.
  // queue_state: ranked-queue entry survived the restart — a no-op refresh confirming it's still active.
  | { kind: 'queue_state' }
  // prematch_lost: this account's pre-match state (room/queue/duel) could not be recovered (created and
  // lost before ever reaching Redis, or Redis itself was unavailable/flushed at restart time).
  | { kind: 'prematch_lost'; context: 'room' | 'queue' | 'duel' };

/**
 * Push callback. `roomId` is a cross-process correlation id — it is included in logs across
 * matchsvc / gateway / game / meta for the same match, so Grafana can reconstruct the full
 * match timeline with `| json | roomId="X"`. Used for logging only; not included in the
 * client-visible PushMsg. Omitted when there is no room context (e.g. ALREADY_IN_ROOM errors).
 */
export type Push = (accountId: string, msg: PushMsg, roomId?: string) => void;

export interface Slot {
  accountId: string;
  name: string;
  publicId: string;
  /** Equipped title id (from meta /internal/profile; empty string = no title). */
  equippedTitle: string;
  /** Equipped avatar id (from meta /internal/profile; empty string = no avatar). */
  avatarId: string;
  /** PvP deck (card ids; validated and resolved by gateway; empty = matchsvc substitutes defaultPvpDeck at startMatch). */
  deck: string[];
  side: 0 | 1;
  ready: boolean;
  connected: boolean;
}
export interface Room {
  roomId: string;
  code: string;
  slots: Slot[];
  phase: number;
  /** Timer that cleans up the room after all players disconnect. Excluded from Redis persistence
   *  (persist.ts's PersistedRoom) — rehydrate re-arms a fresh one if needed (see rehydrate()). */
  reapTimer: NodeJS.Timeout | null;
}

/** Player identity + loadout carried by a pending duel invite, same shape startMatch() takes for each side. */
export interface DuelPlayer {
  accountId: string;
  name: string;
  publicId: string;
  equippedTitle: string;
  avatarId: string;
  deck: string[];
}
export interface DuelInvite {
  inviteId: string;
  from: DuelPlayer;
  toAccountId: string;
  timer: NodeJS.Timeout;
}

// MUST stay identical to client RoomScene.ts (its keypad can only type these
// chars). 10 digits + 11 letters; letters skip I/O/L so they don't read as 0/1.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
const CODE_LEN = 6;
const REAP_MS = 60_000; // grace period to keep the room after all players disconnect
const DUEL_TIMEOUT_MS = 60_000; // friend-challenge response window (ADR: friends-duel-confirm)

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
  /** Active-match Redis client (login-reconnect-prompt), or null when unconfigured — resume prompt is then unavailable but matchmaking is unaffected. */
  redis?: RedisLike | null;
}

export class Matchsvc {
  private readonly rooms = new Map<string, Room>(); // roomId → room
  private readonly byCode = new Map<string, string>(); // code → roomId
  private readonly accountRoom = new Map<string, string>(); // accountId → roomId
  private readonly duelInvites = new Map<string, DuelInvite>(); // inviteId → invite
  private readonly pendingDuelByAccount = new Map<string, string>(); // fromAccountId → inviteId (one outstanding sent invite at a time)
  private readonly matchmaking: Matchmaking;
  private readonly internalKey: string;
  private readonly ticketTtlSec: number;
  private readonly now: () => number;
  private readonly flags?: FeatureFlagCache;
  private readonly redis: RedisLike | null;

  constructor(
    private readonly push: Push,
    private readonly games: GameRegistry,
    internalKey: string,
    opts: MatchsvcOpts = {},
  ) {
    this.internalKey = internalKey;
    this.ticketTtlSec = opts.ticketTtlSec ?? 30;
    this.now = opts.now ?? Date.now;
    this.redis = opts.redis ?? null;
    if (opts.flags) this.flags = opts.flags;
    this.matchmaking = new Matchmaking((a, b) => this.onPair(a, b), {
      now: opts.now,
      autoTick: opts.autoTick,
      botFallbackMs: opts.botFallbackMs ?? 30_000,
      onTimeout: (e) => this.onQueueTimeout(e),
      // matchsvc-prematch-persist (2026-07-29): write-through the ranked queue to Redis (no-op when
      // this.redis is null — see persist.ts's null-safe convention). onDequeued is awaited by
      // Matchmaking.tick()/remove() before any pairing push fires (audit-followup-fixes-0730) — must
      // actually return the delete's promise here, not fire-and-forget it.
      onEnqueued: (e) => void saveQueueEntry(this.redis, e),
      onDequeued: (accountId) => deleteQueueEntry(this.redis, accountId),
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

  // ───────────────────────── Restart-safety rehydrate (matchsvc-prematch-persist, 2026-07-29) ─────────────────────────

  /**
   * Loads pre-match state (rooms / ranked queue / duel invites) back from Redis into the in-memory
   * Maps/array, then actively pushes a refresh to every affected account instead of leaving them to
   * notice via their own (much longer) client-side timeout that matchsvc forgot about them.
   *
   * No-op when `this.redis` is null — matchsvc remains exactly as before this feature existed (pure
   * in-memory, NW_REDIS_URL fully optional; see MatchsvcOpts.redis doc comment).
   *
   * Caller contract (index.ts): await this BEFORE calling startInternalHttp, so gateway/gameserver never
   * see a matchsvc that looks up but hasn't actually rebuilt its in-memory state yet.
   */
  async rehydrate(): Promise<void> {
    if (!this.redis) return;
    const startedAt = this.now();

    // ── Friendly rooms ──
    const { rooms: persistedRooms, lostAccountIds: lostRoomAccountIds } = await loadAllRooms(this.redis);
    for (const p of persistedRooms) {
      if (this.rooms.has(p.roomId)) continue; // defensive only — one process, one rehydrate call
      const room: Room = { ...p, reapTimer: null };
      this.rooms.set(room.roomId, room);
      this.byCode.set(room.code, room.roomId);
      for (const s of room.slots) this.accountRoom.set(s.accountId, room.roomId);
      // A matchsvc restart tells us nothing about whether the gateway connections behind these slots are
      // still live (gateway is a separate process) — conservatively re-arm the full grace period for any
      // room that was already fully disconnected at its last write, so it isn't pinned in memory forever
      // with no live timer to reap it.
      if (room.slots.length > 0 && room.slots.every((s) => !s.connected)) {
        room.reapTimer = setTimeout(() => void this.destroyRoom(room), REAP_MS);
        room.reapTimer.unref?.();
      }
    }

    // ── Ranked queue ──
    const { entries: queueEntries, lostAccountIds: lostQueueAccountIds } = await loadAllQueueEntries(this.redis);
    for (const e of queueEntries) this.matchmaking.rehydrateEntry(e);
    // May immediately pair entries that were already a valid match at restart time (same as a normal
    // tick() would have) — do this before the queue_state push below so we don't tell someone "still
    // searching" right before superseding it with match_found. Must be awaited (audit-followup-fixes-0730):
    // rehydrateDone()'s pairing pass is now async (it awaits the Redis dequeue before pushing match_found,
    // same as a normal tick()), and the `has()` check below needs that pairing to have actually finished —
    // otherwise an entry mid-pairing would still read as "in queue" and get a redundant queue_state push
    // moments before match_found.
    await this.matchmaking.rehydrateDone();

    // ── Friend-challenge ("切磋") duel invites ──
    const { invites: duelInvites, lostFromAccountIds: lostDuelAccountIds } = await loadAllDuelInvites(this.redis);
    const stillPendingInviteIds = new Set<string>();
    for (const inv of duelInvites) {
      const remaining = inv.expiresAt - this.now();
      if (remaining <= 0) {
        // Already past its window by the time we came back up — resolve it exactly like a normal timeout.
        void deleteDuelInvite(this.redis, inv.inviteId, inv.from.accountId);
        this.push(inv.from.accountId, { kind: 'duel_cancelled', inviteId: inv.inviteId, reason: 'timeout' });
        continue;
      }
      const timer = setTimeout(() => this.expireDuel(inv.inviteId), remaining);
      timer.unref?.();
      this.duelInvites.set(inv.inviteId, { inviteId: inv.inviteId, from: inv.from, toAccountId: inv.toAccountId, timer });
      this.pendingDuelByAccount.set(inv.from.accountId, inv.inviteId);
      stillPendingInviteIds.add(inv.inviteId);
    }

    // ── Active notification ──
    for (const room of this.rooms.values()) {
      for (const s of room.slots) this.pushRoomState(s.accountId, room);
    }
    for (const e of queueEntries) {
      // Skip accounts that got paired during rehydrateDone() above — they already received match_found.
      if (this.matchmaking.has(e.accountId)) this.push(e.accountId, { kind: 'queue_state' });
    }
    for (const accountId of lostQueueAccountIds) this.push(accountId, { kind: 'prematch_lost', context: 'queue' });
    for (const inv of duelInvites) {
      if (stillPendingInviteIds.has(inv.inviteId)) {
        this.push(inv.toAccountId, { kind: 'duel_invited', inviteId: inv.inviteId, fromPublicId: inv.from.publicId, fromName: inv.from.name });
      }
    }
    for (const accountId of lostDuelAccountIds) this.push(accountId, { kind: 'prematch_lost', context: 'duel' });
    for (const accountId of lostRoomAccountIds) this.push(accountId, { kind: 'prematch_lost', context: 'room' });

    log.info('rehydrate complete', {
      rooms: persistedRooms.length,
      queueEntries: queueEntries.length,
      queueLost: lostQueueAccountIds.length,
      duelInvites: duelInvites.length,
      duelLost: lostDuelAccountIds.length,
      roomLost: lostRoomAccountIds.length,
      ms: this.now() - startedAt,
    });
  }

  // ───────────────────────── ranked matchmaking ─────────────────────────

  /**
   * Start ranked matchmaking (elo is fetched by the gateway from meta and passed in). Ignored if
   * the player is already in a room or queue. publicId is carried with the queue entry: ranked
   * matches don't show room slots, but after the match starts the opponent's publicId must be
   * written into the ticket → match_start for the in-game profile popup.
   */
  async enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', avatarId = '', platform = '', deck: string[] = []): Promise<void> {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      log.warn('enqueue ignored: already in room/queue', { accountId });
      return;
    }
    await this.matchmaking.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, platform, deck);
    log.info('enqueued for ranked', { accountId, elo, queueSize: this.matchmaking.size });
  }

  /**
   * Decision point when a player has waited beyond the threshold (default 30s): if feature flag
   * `match_bot_fallback` is enabled for this player, dequeue and push match_bot (client opens a
   * local AI match); otherwise keep in queue waiting for a human opponent (no behaviour change).
   * If flags is absent or admin is unreachable, treated as off (default false), gracefully
   * degrading to "keep waiting indefinitely".
   */
  private async onQueueTimeout(entry: QueueEntry): Promise<void> {
    const on =
      this.flags?.isOn('match_bot_fallback', {
        accountId: entry.accountId,
        ...(entry.platform ? { platform: entry.platform as never } : {}),
      }) ?? false;
    if (!on) {
      log.info('queue timeout: bot fallback OFF → keep waiting for human', { accountId: entry.accountId });
      return;
    }
    // Awaited (audit-followup-fixes-0730, same reasoning as the real-pairing path in Matchmaking.tick):
    // a crash between this dequeue and the match_bot push below must never leave the Redis mirror still
    // holding this entry, or rehydrate would re-admit an account that already got a bot match offer.
    await this.matchmaking.remove(entry.accountId);
    const seed = randomInt(1, 2 ** 48);
    const opponentName = randomPlayerName((n) => randomInt(n));
    const difficulty = pickBotDifficulty(entry.elo, (n) => randomInt(0, n));
    log.info('queue timeout: bot fallback ON → match_bot', { accountId: entry.accountId, elo: entry.elo, seed, difficulty });
    this.push(entry.accountId, { kind: 'match_bot', seed, opponentName, elo: entry.elo, difficulty: String(difficulty) });
  }

  /** Matchmaking pair found → start the match immediately (no ready / host step). */
  private onPair(a: QueueEntry, b: QueueEntry): void {
    log.info('ranked pair matched', { a: a.accountId, b: b.accountId, eloA: a.elo, eloB: b.elo });
    this.startMatch(
      'ranked',
      { accountId: a.accountId, name: a.name, publicId: a.publicId, equippedTitle: a.equippedTitle, avatarId: a.avatarId, deck: a.deck },
      { accountId: b.accountId, name: b.name, publicId: b.publicId, equippedTitle: b.equippedTitle, avatarId: b.avatarId, deck: b.deck },
    );
  }

  // ───────────────────────── friendly rooms ─────────────────────────

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = '', avatarId = '', deck: string[] = []): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = this.uniqueCode();
    const roomId = randomUUID();
    const room: Room = {
      roomId,
      code,
      slots: [{ accountId, name, publicId, equippedTitle, avatarId, deck, side: 0, ready: false, connected: true }],
      phase: RoomPhase.WAITING,
      reapTimer: null,
    };
    this.rooms.set(roomId, room);
    this.byCode.set(code, roomId);
    this.accountRoom.set(accountId, roomId);
    log.info('room created', { accountId, code, roomId });
    void saveRoom(this.redis, room);
    this.broadcast(room);
  }

  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = '', avatarId = '', deck: string[] = []): void {
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
    room.slots.push({ accountId, name, publicId, equippedTitle, avatarId, deck, side: 1, ready: false, connected: true });
    this.accountRoom.set(accountId, room.roomId);
    log.info('room joined', { accountId, code, roomId: room.roomId });
    void saveRoom(this.redis, room);
    this.broadcast(room);
  }

  async roomReady(accountId: string, ready: boolean): Promise<void> {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.ready = ready;
    const allReady = room.slots.length === 2 && room.slots.every((s) => s.ready);
    room.phase = allReady ? RoomPhase.READY : RoomPhase.WAITING;
    void saveRoom(this.redis, room);
    this.broadcast(room);

    // Both players ready → start automatically. Previously this only flipped the
    // phase to READY and waited for the host to press "start", which players read
    // as the game failing to start. Auto-start (like ranked) removes that gap.
    if (allReady) {
      const [s0, s1] = room.slots;
      // Awaited (audit-followup-fixes-0730): a crash between the Redis-side room deletion and the
      // match_found push below must never leave the room's Redis mirror intact — rehydrate() re-admitting
      // a room whose slots were already told they matched would re-broadcast room_state for a match that
      // has already moved on to gameserver.
      await this.destroyRoom(room); // lobby room's job done; match state is now owned by gameserver
      this.startMatch(
        'friendly',
        { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, avatarId: s0!.avatarId, deck: s0!.deck },
        { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, avatarId: s1!.avatarId, deck: s1!.deck },
      );
    }
  }

  /**
   * Host (side 0) starts the match after both players are ready. Both-ready now auto-starts via
   * {@link roomReady}; this entry point is kept for backwards compatibility with older clients that
   * send an explicit start button press (the room will already be destroyed at that point →
   * roomOf returns undefined → no-op).
   *
   * Correction (comm-audit-internal-2026-07-28): an earlier pass on this file removed this method
   * as a "guaranteed no-op" per the P2 dead-code audit finding — but matchsvc.test.ts and
   * gateway/test/{gateway-routing,matchsvcClient}.test.ts call it directly to verify exactly that
   * no-op behavior (and the non-host / not-all-ready rejection paths below), so removing the method
   * itself (not just making it unreachable in practice) broke 9 passing tests. Restored verbatim.
   */
  async roomStart(accountId: string): Promise<void> {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const host = room.slots.find((s) => s.side === 0);
    if (!host || host.accountId !== accountId) return;
    if (room.slots.length !== 2 || !room.slots.every((s) => s.ready)) return;

    const [s0, s1] = room.slots;
    await this.destroyRoom(room); // lobby room's job done; match state is now owned by gameserver (see roomReady's await for why)
    this.startMatch(
      'friendly',
      { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, avatarId: s0!.avatarId, deck: s0!.deck },
      { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, avatarId: s1!.avatarId, deck: s1!.deck },
    );
  }

  /** Leave the room / cancel queuing. */
  roomLeave(accountId: string): void {
    void this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    this.removeFromRoom(room, accountId);
  }

  // ───────────────────────── Friend challenge ("切磋") ─────────────────────────
  // No room code exchange: the gateway already knows both accountIds (its own connection for the
  // inviter, resolved from the target's publicId for the invitee) — this is a pending-invite +
  // 60s-timeout layer on top of the same startMatch() the room-ready flow already uses.

  /** `from` is fully resolved by the gateway (profile + elo-validated deck) before this is called. */
  duelInvite(from: DuelPlayer, toAccountId: string): void {
    // A second invite from the same inviter replaces the first (re-clicking "duel" reads as "retry",
    // not "queue another one") — cancel the stale one the same way a decline would.
    const prevId = this.pendingDuelByAccount.get(from.accountId);
    if (prevId) this.cancelDuel(prevId, 'declined');

    const inviteId = randomUUID();
    const expiresAt = this.now() + DUEL_TIMEOUT_MS;
    const timer = setTimeout(() => this.expireDuel(inviteId), DUEL_TIMEOUT_MS);
    timer.unref?.();
    this.duelInvites.set(inviteId, { inviteId, from, toAccountId, timer });
    this.pendingDuelByAccount.set(from.accountId, inviteId);
    log.info('duel invite sent', { from: from.accountId, toAccountId, inviteId });
    void saveDuelInvite(this.redis, { inviteId, from, toAccountId, expiresAt });
    this.push(toAccountId, { kind: 'duel_invited', inviteId, fromPublicId: from.publicId, fromName: from.name });
  }

  /**
   * `toAccountId` must be the invite's actual recipient (mismatched/unknown inviteId is silently
   * ignored — stale UI on a slow client, nothing to correct). `profile` is the responder's own
   * resolved identity + elo-validated deck (gateway); omitted on decline, required to accept.
   */
  async duelRespond(toAccountId: string, inviteId: string, accept: boolean, profile?: DuelPlayer): Promise<void> {
    const invite = this.duelInvites.get(inviteId);
    if (!invite || invite.toAccountId !== toAccountId) return;
    clearTimeout(invite.timer);
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    // Awaited on the accept path (audit-followup-fixes-0730 — same reasoning as roomReady/tick): a crash
    // between this and startMatch's match_found push must never leave the invite's Redis mirror intact,
    // or rehydrate() would re-push duel_invited for an invite that was already accepted and started.
    // The decline path below has no following push that depends on it, so it stays fire-and-forget.
    if (accept && profile) {
      await deleteDuelInvite(this.redis, inviteId, invite.from.accountId);
      log.info('duel accepted -> startMatch', { inviteId, from: invite.from.accountId, toAccountId });
      this.startMatch('friendly', invite.from, profile);
      return;
    }
    void deleteDuelInvite(this.redis, inviteId, invite.from.accountId);
    log.info('duel declined', { inviteId, from: invite.from.accountId, toAccountId });
    this.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason: 'declined' });
  }

  /** Invite timed out with no response (60s) — notify the inviter only; the never-responding
   *  invitee's client self-clears the banner locally once its own countdown reaches zero. */
  private expireDuel(inviteId: string): void {
    const invite = this.duelInvites.get(inviteId);
    if (!invite) return;
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    void deleteDuelInvite(this.redis, inviteId, invite.from.accountId);
    log.info('duel invite timed out', { inviteId, from: invite.from.accountId });
    this.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason: 'timeout' });
  }

  /** Shared by duelInvite's replace-on-reinvite path; same effect as a decline from the invitee's side. */
  private cancelDuel(inviteId: string, reason: string): void {
    const invite = this.duelInvites.get(inviteId);
    if (!invite) return;
    clearTimeout(invite.timer);
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    void deleteDuelInvite(this.redis, inviteId, invite.from.accountId);
    this.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason });
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
      void saveRoom(this.redis, room);
      this.broadcast(room);
    } else {
      this.pushRoomState(accountId, room); // resend only to this player
    }
  }

  /** Account disconnected from gateway: remove from queue; if in a lobby room mark as disconnected (retain within grace period to support control-plane reconnect). */
  onDisconnected(accountId: string): void {
    void this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.connected = false;
    if (room.slots.every((s) => !s.connected)) {
      room.reapTimer = setTimeout(() => void this.destroyRoom(room), REAP_MS);
      room.reapTimer.unref?.();
    }
    void saveRoom(this.redis, room);
    this.broadcast(room);
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
    a: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string; deck: string[] },
    b: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string; deck: string[] },
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
    // Every matchsvc match is PvP, which must never draw from the full card pool. An empty deck (missing
    // or unvalidated upstream) is resolved to defaultPvpDeck here so the engine always gets a gated deck —
    // the engine's undefined-decks fallback is the full CARD_DEFINITIONS pool, which would leak locked units.
    const decks = {
      top: a.deck.length > 0 ? a.deck : defaultPvpDeck(),
      bottom: b.deck.length > 0 ? b.deck : defaultPvpDeck(),
    };
    log.info('match starting', { mode, roomId, gameUrl, a: a.accountId, b: b.accountId, seed, topDeck: decks.top.length, bottomDeck: decks.bottom.length });

    const sign = (
      self: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string },
      opp: { accountId: string; name: string; publicId: string; equippedTitle: string; avatarId: string },
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
        opponentAvatarId: opp.avatarId || undefined,
        gameUrl,
        accountId: self.accountId,
        decks,
      };
      return signTicket(claims, { key: this.internalKey, ttlSec: this.ticketTtlSec });
    };

    const ticketA = sign(a, b, 0);
    const ticketB = sign(b, a, 1);

    // Cache both tickets under accountId so a later re-login can offer "resume this match?" and
    // reconnect straight into the room — gameserver's initial handshake ignores ticket exp (M16),
    // so these remain usable for the whole match, not just the 30s matchmaking handshake window.
    // Best-effort: matchmaking must not fail if Redis is unavailable.
    void setActiveMatch(this.redis, a.accountId, { roomId, gameUrl, ticket: ticketA, mode }).catch((e) =>
      log.warn('setActiveMatch failed', { accountId: a.accountId, roomId, err: (e as Error).message }),
    );
    void setActiveMatch(this.redis, b.accountId, { roomId, gameUrl, ticket: ticketB, mode }).catch((e) =>
      log.warn('setActiveMatch failed', { accountId: b.accountId, roomId, err: (e as Error).message }),
    );

    this.push(a.accountId, { kind: 'match_found', gameUrl, ticket: ticketA }, roomId);
    this.push(b.accountId, { kind: 'match_found', gameUrl, ticket: ticketB }, roomId);
  }

  // ───────────────────────── Internal ─────────────────────────

  private roomOf(accountId: string): Room | undefined {
    const id = this.accountRoom.get(accountId);
    return id ? this.rooms.get(id) : undefined;
  }

  private removeFromRoom(room: Room, accountId: string): void {
    room.slots = room.slots.filter((s) => s.accountId !== accountId);
    this.accountRoom.delete(accountId);
    // The departing account's own reverse-lookup key is never covered by destroyRoom's/saveRoom's slot
    // iteration below (both only see the *remaining* slots) — clear it explicitly either way.
    void clearRoomAccount(this.redis, accountId);
    if (room.slots.length === 0) {
      void this.destroyRoom(room);
      return;
    }
    // Remaining player takes side 0 (host) and their ready flag is reset.
    room.slots[0]!.side = 0;
    room.slots[0]!.ready = false;
    room.phase = RoomPhase.WAITING;
    void saveRoom(this.redis, room);
    this.broadcast(room);
  }

  /**
   * Returns the deleteRoom promise (not fire-and-forget): roomReady/roomStart's auto-start path awaits it
   * before startMatch's match_found push (audit-followup-fixes-0730). Callers with no following push that
   * depends on it (removeFromRoom, the reap timer) call this without awaiting, unchanged from before.
   */
  private async destroyRoom(room: Room): Promise<void> {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
    for (const s of room.slots) this.accountRoom.delete(s.accountId);
    this.byCode.delete(room.code);
    this.rooms.delete(room.roomId);
    await deleteRoom(this.redis, room);
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
