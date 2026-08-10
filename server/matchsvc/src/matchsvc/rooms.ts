// Matchsvc.ts split (2026-08-10, ≤500-line convention, composition layer — the base every other admission
// check reads through the narrow `RoomLookupPort` surface, mirroring gateway's connRegistry.ts role): owns
// the friendly-room state (rooms/byCode/accountRoom maps) and the reap-timer lifecycle. Talks to the shared
// `MatchStarterPort` (both-ready auto-start / explicit host start) but never imports queue.ts or duel.ts
// directly — the "already queued?" half of the ALREADY_IN_ROOM guard is read by Matchsvc.ts's shell from
// queue.ts instead of from here, precisely so this stays the one-directional foundational layer (see
// types.ts's RoomLookupPort doc comment for the full reasoning).
import { randomUUID, randomInt } from 'crypto';
import { createLogger, type RedisLike } from '@nw/shared';
import { saveRoom, clearRoomAccount, deleteRoom, type PersistedRoom } from '../persist';
import { CODE_ALPHABET, CODE_LEN, REAP_MS, RoomPhase, type MatchStarterPort, type PlayerView, type Push, type Room, type Slot } from './types';

const log = createLogger('matchsvc');

export interface RoomRegistryDeps {
  push: Push;
  redis: RedisLike | null;
  matchStarter: MatchStarterPort;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>(); // roomId → room
  private readonly byCode = new Map<string, string>(); // code → roomId
  private readonly accountRoom = new Map<string, string>(); // accountId → roomId

  constructor(private readonly deps: RoomRegistryDeps) {}

  get size(): number {
    return this.rooms.size;
  }

  /** The "already busy" source of truth read one-directionally by queue.ts's enqueue() — see
   *  RoomLookupPort's doc comment in types.ts. */
  hasRoom(accountId: string): boolean {
    return this.accountRoom.has(accountId);
  }

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = '', avatarId = '', deck: string[] = [], equippedSkins: string[] = []): void {
    if (this.accountRoom.has(accountId)) {
      this.deps.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = this.uniqueCode();
    const roomId = randomUUID();
    const room: Room = {
      roomId,
      code,
      slots: [{ accountId, name, publicId, equippedTitle, avatarId, equippedSkins, deck, side: 0, ready: false, connected: true }],
      phase: RoomPhase.WAITING,
      reapTimer: null,
    };
    this.rooms.set(roomId, room);
    this.byCode.set(code, roomId);
    this.accountRoom.set(accountId, roomId);
    log.info('room created', { accountId, code, roomId });
    void saveRoom(this.deps.redis, room);
    this.broadcast(room);
  }

  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = '', avatarId = '', deck: string[] = [], equippedSkins: string[] = []): void {
    if (this.accountRoom.has(accountId)) {
      this.deps.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const roomId = this.byCode.get(code.toUpperCase());
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) {
      log.warn('join failed: room not found', { accountId, code });
      this.deps.push(accountId, { kind: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no such room' });
      return;
    }
    if (room.slots.length >= 2) {
      log.warn('join failed: room full', { accountId, code });
      this.deps.push(accountId, { kind: 'room_error', code: 'ROOM_FULL', message: 'room is full' });
      return;
    }
    room.slots.push({ accountId, name, publicId, equippedTitle, avatarId, equippedSkins, deck, side: 1, ready: false, connected: true });
    this.accountRoom.set(accountId, room.roomId);
    log.info('room joined', { accountId, code, roomId: room.roomId });
    void saveRoom(this.deps.redis, room);
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
    void saveRoom(this.deps.redis, room);
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
      this.deps.matchStarter.start(
        'friendly',
        { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, avatarId: s0!.avatarId, equippedSkins: s0!.equippedSkins, deck: s0!.deck },
        { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, avatarId: s1!.avatarId, equippedSkins: s1!.equippedSkins, deck: s1!.deck },
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
    this.deps.matchStarter.start(
      'friendly',
      { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle, avatarId: s0!.avatarId, equippedSkins: s0!.equippedSkins, deck: s0!.deck },
      { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle, avatarId: s1!.avatarId, equippedSkins: s1!.equippedSkins, deck: s1!.deck },
    );
  }

  /** Leave the room. (Cancelling ranked queueing is queue.ts's dequeue() — Matchsvc.ts's shell calls both.) */
  roomLeave(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room) return;
    this.removeFromRoom(room, accountId);
  }

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
      void saveRoom(this.deps.redis, room);
      this.broadcast(room);
    } else {
      this.pushRoomState(accountId, room); // resend only to this player
    }
  }

  /** Account disconnected from gateway: if in a lobby room mark as disconnected (retain within grace
   *  period to support control-plane reconnect). (Dropping from the ranked queue is queue.ts's dequeue()
   *  — Matchsvc.ts's shell calls both.) */
  onDisconnected(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.connected = false;
    if (room.slots.every((s) => !s.connected)) {
      room.reapTimer = setTimeout(() => void this.destroyRoom(room), REAP_MS);
      room.reapTimer.unref?.();
    }
    void saveRoom(this.deps.redis, room);
    this.broadcast(room);
  }

  // ───────────────────────── Restart-safety rehydrate (matchsvc-prematch-persist, 2026-07-29) ─────────────────────────

  /** Loads persisted rooms back into the in-memory maps and re-arms reap timers for fully-disconnected
   *  ones — no push here (Matchsvc.ts's rehydrate() calls broadcastAllRoomStates() separately, after
   *  queue/duel have also loaded, to preserve the original single-pass "active notification" ordering). */
  hydrateAll(persistedRooms: PersistedRoom[]): void {
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
  }

  /** Active notification (rehydrate's final pass): push the current room_state to every slot of every
   *  rehydrated room. */
  broadcastAllRoomStates(): void {
    for (const room of this.rooms.values()) {
      for (const s of room.slots) this.pushRoomState(s.accountId, room);
    }
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
    void clearRoomAccount(this.deps.redis, accountId);
    if (room.slots.length === 0) {
      void this.destroyRoom(room);
      return;
    }
    // Remaining player takes side 0 (host) and their ready flag is reset.
    room.slots[0]!.side = 0;
    room.slots[0]!.ready = false;
    room.phase = RoomPhase.WAITING;
    void saveRoom(this.deps.redis, room);
    this.broadcast(room);
  }

  /**
   * Returns the deleteRoom promise (not fire-and-forget): roomReady/roomStart's auto-start path awaits it
   * before matchStarter.start's match_found push (audit-followup-fixes-0730). Callers with no following push
   * that depends on it (removeFromRoom, the reap timer) call this without awaiting, unchanged from before.
   */
  private async destroyRoom(room: Room): Promise<void> {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
    for (const s of room.slots) this.accountRoom.delete(s.accountId);
    this.byCode.delete(room.code);
    this.rooms.delete(room.roomId);
    await deleteRoom(this.deps.redis, room);
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
    this.deps.push(
      accountId,
      { kind: 'room_state', code: room.code, players: this.playersView(room), phase: room.phase },
      room.roomId,
    );
  }

  private broadcast(room: Room): void {
    const players = this.playersView(room);
    for (const s of room.slots) {
      this.deps.push(s.accountId, { kind: 'room_state', code: room.code, players, phase: room.phase }, room.roomId);
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
