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
//
// Assembly shell (2026-08-10 split, ≤500-line convention, see claudedocs/server.md "单文件 500 行收敛" §拆分形态
// 优先级 — 独立类 + 组合): the class below used to hold ALL of this service's state and logic (730 lines).
// It now only constructs and wires four independent classes under `matchsvc/` and forwards its original
// public methods to them — no behavior changed, every external import path (`./Matchsvc`) is unchanged.
//   • matchStarter — picks a game server, signs both sides' tickets, pushes match_found (shared base;
//                    rooms/queue/duel all depend on it, it depends on none of them).
//   • rooms        — friendly-room state (create/join/ready/start/leave) + connection lifecycle.
//   • queue        — ranked ELO-proximity matchmaking (enqueue, bot-fallback timeout, pair → start).
//   • duel         — friend-challenge ("切磋") pending-invite + 60s-timeout layer.
// queue depends on rooms one-directionally (narrow RoomLookupPort, "already in a room?" at enqueue time);
// duel depends on both rooms and queue the same way (narrow RoomLookupPort/QueueLookupPort, "already
// committed elsewhere?" at invite/accept time — matchmaking-mutex-audit, 2026-08-12); rooms/queue/duel
// each depend on matchStarter (narrow MatchStarterPort). No sibling ever depends back on one that depends
// on it. The other half of the cross-check — "already queued?" for roomCreate/roomJoin's ALREADY_IN_ROOM
// guard — is read by this shell from queue.hasQueued() directly below, rather than giving rooms.ts a
// dependency on queue.ts, so rooms.ts stays the one-directional foundational layer (see
// matchsvc/types.ts's RoomLookupPort doc comment). Likewise roomLeave/onDisconnected call both queue.dequeue()
// and rooms' own handling — that's this shell (the parent) calling two children, not a sibling-to-sibling edge.
import { createLogger, type FeatureFlagCache, type RedisLike } from '@nw/shared';
import type { GameRegistry } from './GameRegistry';
import { loadAllRooms, loadAllQueueEntries, loadAllDuelInvites } from './persist';
import { MatchStarter } from './matchsvc/matchStarter';
import { RoomRegistry } from './matchsvc/rooms';
import { RankedQueue } from './matchsvc/queue';
import { DuelService } from './matchsvc/duel';
import { CODE_ALPHABET, RoomPhase, type DuelInvite, type DuelPlayer, type PlayerView, type Push, type PushMsg, type Room, type Slot } from './matchsvc/types';

export { CODE_ALPHABET, RoomPhase };
export type { DuelInvite, DuelPlayer, PlayerView, Push, PushMsg, Room, Slot };

const log = createLogger('matchsvc');

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
  private readonly rooms: RoomRegistry;
  private readonly queue: RankedQueue;
  private readonly duel: DuelService;
  private readonly redis: RedisLike | null;
  private readonly now: () => number;

  constructor(
    private readonly push: Push,
    private readonly games: GameRegistry,
    internalKey: string,
    opts: MatchsvcOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.redis = opts.redis ?? null;
    // matchStarter is constructed first (it owns no state shared with rooms/queue/duel — see this file's
    // header comment) so each of them can take it as a constructor dep.
    const matchStarter = new MatchStarter({
      push,
      games,
      internalKey,
      ticketTtlSec: opts.ticketTtlSec ?? 30,
      redis: this.redis,
    });
    this.rooms = new RoomRegistry({ push, redis: this.redis, matchStarter });
    this.queue = new RankedQueue({
      push,
      rooms: this.rooms,
      matchStarter,
      redis: this.redis,
      flags: opts.flags,
      botFallbackMs: opts.botFallbackMs ?? 30_000,
      now: opts.now,
      autoTick: opts.autoTick,
    });
    // rooms/queue passed one-directionally (narrow RoomLookupPort/QueueLookupPort read, see duel.ts's
    // header comment) — duel.ts uses them to reject an invite/accept when either party is already
    // committed to a room or the ranked queue, same "leave first" policy as the room↔queue guard above.
    this.duel = new DuelService({ push, redis: this.redis, now: this.now, matchStarter, rooms: this.rooms, queue: this.queue });
  }

  /**
   * Real-time aggregate (admin GET /internal/stats, OPS_DESIGN §4.1): ranked queue length /
   * active friendly room count / healthy game instance count / total game load.
   */
  stats(): { queue: number; rooms: number; gameInstances: number; gameLoad: number } {
    const g = this.games.stats();
    return {
      queue: this.queue.size,
      rooms: this.rooms.size,
      gameInstances: g.instances,
      gameLoad: g.load,
    };
  }

  // ───────────────────────── Restart-safety rehydrate (matchsvc-prematch-persist, 2026-07-29) ─────────────────────────

  /**
   * Loads pre-match state (rooms / ranked queue / duel invites) back from Redis into each layer's
   * in-memory state, then actively pushes a refresh to every affected account instead of leaving them to
   * notice via their own (much longer) client-side timeout that matchsvc forgot about them.
   *
   * No-op when `this.redis` is null — matchsvc remains exactly as before this feature existed (pure
   * in-memory, NW_REDIS_URL fully optional; see MatchsvcOpts.redis doc comment).
   *
   * Caller contract (index.ts): await this BEFORE calling startInternalHttp, so gateway/gameserver never
   * see a matchsvc that looks up but hasn't actually rebuilt its in-memory state yet.
   *
   * Orchestrates the three layers in the same order/grouping as the original single-method implementation
   * (load rooms → load+pair queue → load duel invites → one "active notification" pass over all three) —
   * each layer's hydrateAll()/hydrate-adjacent methods do the loading + own-account pushes (queue's
   * immediate pairing, duel's immediate timeout-resolution); this method does the final active-notification
   * pass exactly as before.
   */
  async rehydrate(): Promise<void> {
    if (!this.redis) return;
    const startedAt = this.now();

    // ── Friendly rooms ──
    const { rooms: persistedRooms, lostAccountIds: lostRoomAccountIds } = await loadAllRooms(this.redis);
    this.rooms.hydrateAll(persistedRooms);

    // ── Ranked queue ──
    // May immediately pair entries that were already a valid match at restart time (same as a normal
    // tick() would have) — do this before the queue_state push below so we don't tell someone "still
    // searching" right before superseding it with match_found. Must be awaited (audit-followup-fixes-0730):
    // hydrateAll()'s pairing pass is async, and the pushSurvivingQueueState() check below needs that
    // pairing to have actually finished — otherwise an entry mid-pairing would still read as "in queue" and
    // get a redundant queue_state push moments before match_found.
    const { entries: queueEntries, lostAccountIds: lostQueueAccountIds } = await loadAllQueueEntries(this.redis);
    await this.queue.hydrateAll(queueEntries);

    // ── Friend-challenge ("切磋") duel invites ──
    const { invites: duelInvites, lostFromAccountIds: lostDuelAccountIds } = await loadAllDuelInvites(this.redis);
    const stillPendingInviteIds = this.duel.hydrateAll(duelInvites);

    // ── Active notification ──
    this.rooms.broadcastAllRoomStates();
    this.queue.pushSurvivingQueueState(queueEntries);
    for (const accountId of lostQueueAccountIds) this.push(accountId, { kind: 'prematch_lost', context: 'queue' });
    this.duel.pushStillPending(duelInvites, stillPendingInviteIds);
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

  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', avatarId = '', platform = '', deck: string[] = [], equippedSkins: string[] = []): Promise<void> {
    return this.queue.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, platform, deck, equippedSkins);
  }

  // ───────────────────────── friendly rooms ─────────────────────────

  /** The other half of this guard ("already in a room?") is rooms.roomCreate's own internal check —
   *  see this file's header comment for why the two halves live on opposite sides of the rooms/queue split. */
  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = '', avatarId = '', deck: string[] = [], equippedSkins: string[] = []): void {
    if (this.queue.hasQueued(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    this.rooms.roomCreate(accountId, name, publicId, equippedTitle, avatarId, deck, equippedSkins);
  }

  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = '', avatarId = '', deck: string[] = [], equippedSkins: string[] = []): void {
    if (this.queue.hasQueued(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    this.rooms.roomJoin(accountId, name, publicId, code, equippedTitle, avatarId, deck, equippedSkins);
  }

  roomReady(accountId: string, ready: boolean): Promise<void> {
    return this.rooms.roomReady(accountId, ready);
  }

  roomStart(accountId: string): Promise<void> {
    return this.rooms.roomStart(accountId);
  }

  /** Leave the room / cancel queuing. */
  roomLeave(accountId: string): void {
    this.queue.dequeue(accountId);
    this.rooms.roomLeave(accountId);
  }

  // ───────────────────────── Friend challenge ("切磋") ─────────────────────────

  duelInvite(from: DuelPlayer, toAccountId: string): void {
    this.duel.duelInvite(from, toAccountId);
  }

  duelRespond(toAccountId: string, inviteId: string, accept: boolean, profile?: DuelPlayer): Promise<void> {
    return this.duel.duelRespond(toAccountId, inviteId, accept, profile);
  }

  // ───────────────────────── Connection lifecycle (gateway notifications) ─────────────────────────

  onConnected(accountId: string): void {
    this.rooms.onConnected(accountId);
  }

  onDisconnected(accountId: string): void {
    this.queue.dequeue(accountId);
    this.rooms.onDisconnected(accountId);
  }

  // ───────────────────────── game registry ─────────────────────────

  registerGame(gameId: string, wsUrl: string, capacity: number): void {
    log.info('game server registered', { gameId, wsUrl, capacity });
    this.games.register(gameId, wsUrl, capacity);
  }

  gameHeartbeat(gameId: string, load: number, rooms: number): void {
    this.games.heartbeat(gameId, load, rooms);
  }
}
