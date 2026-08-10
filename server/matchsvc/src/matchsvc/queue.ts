// Matchsvc.ts split (2026-08-10, ≤500-line convention, composition layer): ranked matchmaking — wraps the
// ELO-proximity queue (Matchmaking) plus the two decision points around it (bot-fallback timeout, pair
// found → launch via the shared MatchStarterPort). Depends on `RoomLookupPort` (narrow: only `.hasRoom()`)
// to reject "already in a friendly room" at enqueue time — one-directional (queue.ts → rooms.ts), rooms.ts
// never imports this file back, so composing rooms/queue/duel stays acyclic (see types.ts's RoomLookupPort
// doc comment).
import { randomInt } from 'crypto';
import { createLogger, pickBotDifficulty, randomPlayerName, type FeatureFlagCache, type RedisLike } from '@nw/shared';
import { Matchmaking, type QueueEntry } from '../Matchmaking';
import { saveQueueEntry, deleteQueueEntry } from '../persist';
import type { MatchStarterPort, Push, RoomLookupPort } from './types';

const log = createLogger('matchsvc');

export interface RankedQueueDeps {
  push: Push;
  rooms: RoomLookupPort;
  matchStarter: MatchStarterPort;
  redis: RedisLike | null;
  /** Feature flag cache (polls admin for raw rules + evaluates locally). Absent = unavailable; match_bot_fallback treated as off. */
  flags?: FeatureFlagCache;
  /** If a player has been queued for longer than this many milliseconds, evaluate match_bot_fallback to decide whether to fall back to an AI match. */
  botFallbackMs: number;
  /** Injected clock (for testing). */
  now?: () => number;
  /** Matchmaking auto-tick switch (disable in tests to tick manually). */
  autoTick?: boolean;
}

export class RankedQueue {
  private readonly matchmaking: Matchmaking;

  constructor(private readonly deps: RankedQueueDeps) {
    this.matchmaking = new Matchmaking((a, b) => this.onPair(a, b), {
      now: deps.now,
      autoTick: deps.autoTick,
      botFallbackMs: deps.botFallbackMs,
      onTimeout: (e) => this.onQueueTimeout(e),
      // matchsvc-prematch-persist (2026-07-29): write-through the ranked queue to Redis (no-op when
      // deps.redis is null — see persist.ts's null-safe convention). onDequeued is awaited by
      // Matchmaking.tick()/remove() before any pairing push fires (audit-followup-fixes-0730) — must
      // actually return the delete's promise here, not fire-and-forget it.
      onEnqueued: (e) => void saveQueueEntry(deps.redis, e),
      onDequeued: (accountId) => deleteQueueEntry(deps.redis, accountId),
    });
  }

  get size(): number {
    return this.matchmaking.size;
  }

  hasQueued(accountId: string): boolean {
    return this.matchmaking.has(accountId);
  }

  /**
   * Start ranked matchmaking (elo is fetched by the gateway from meta and passed in). Ignored if
   * the player is already in a room or queue. publicId is carried with the queue entry: ranked
   * matches don't show room slots, but after the match starts the opponent's publicId must be
   * written into the ticket → match_start for the in-game profile popup.
   */
  async enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', avatarId = '', platform = '', deck: string[] = [], equippedSkins: string[] = []): Promise<void> {
    if (this.deps.rooms.hasRoom(accountId) || this.matchmaking.has(accountId)) {
      log.warn('enqueue ignored: already in room/queue', { accountId });
      return;
    }
    await this.matchmaking.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, platform, deck, equippedSkins);
    log.info('enqueued for ranked', { accountId, elo, queueSize: this.matchmaking.size });
  }

  /** Cancel search (roomLeave's server-side entry point) / drop from queue on disconnect. Fire-and-forget,
   *  same as the original inline `void this.matchmaking.remove(accountId)` call sites. */
  dequeue(accountId: string): void {
    void this.matchmaking.remove(accountId);
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
      this.deps.flags?.isOn('match_bot_fallback', {
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
    this.deps.push(entry.accountId, { kind: 'match_bot', seed, opponentName, elo: entry.elo, difficulty: String(difficulty) });
  }

  /** Matchmaking pair found → start the match immediately (no ready / host step). */
  private onPair(a: QueueEntry, b: QueueEntry): void {
    log.info('ranked pair matched', { a: a.accountId, b: b.accountId, eloA: a.elo, eloB: b.elo });
    this.deps.matchStarter.start(
      'ranked',
      { accountId: a.accountId, name: a.name, publicId: a.publicId, equippedTitle: a.equippedTitle, avatarId: a.avatarId, equippedSkins: a.equippedSkins, deck: a.deck },
      { accountId: b.accountId, name: b.name, publicId: b.publicId, equippedTitle: b.equippedTitle, avatarId: b.avatarId, equippedSkins: b.equippedSkins, deck: b.deck },
    );
  }

  // ───────────────────────── Restart-safety rehydrate (matchsvc-prematch-persist, 2026-07-29) ─────────────────────────

  /** Loads persisted queue entries back in and runs one pairing pass — may immediately pair entries that
   *  were already a valid match at restart time (same as a normal tick() would have), pushing match_found
   *  via matchStarter before returning. Must be awaited by the caller (audit-followup-fixes-0730): the
   *  pairing pass is async (it awaits the Redis dequeue before pushing match_found, same as a normal
   *  tick()), and Matchsvc.ts's rehydrate() needs that pairing to have actually finished before its own
   *  "still queued?" check below (pushSurvivingQueueState). */
  async hydrateAll(entries: QueueEntry[]): Promise<void> {
    for (const e of entries) this.matchmaking.rehydrateEntry(e);
    await this.matchmaking.rehydrateDone();
  }

  /** Active notification (rehydrate's final pass): a no-op queue_state refresh for every entry that
   *  survived rehydrateAll() without getting paired (paired entries already received match_found). */
  pushSurvivingQueueState(entries: QueueEntry[]): void {
    for (const e of entries) {
      if (this.matchmaking.has(e.accountId)) this.deps.push(e.accountId, { kind: 'queue_state' });
    }
  }
}
