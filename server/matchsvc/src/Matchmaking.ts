// Ranked matchmaking queue (S1-R, migrated from gameserver with connection dependencies decoupled). Pairs players by ELO proximity;
// the longer a player waits, the wider the acceptable ELO window, ensuring matches can form within a bounded wait even during off-peak hours.
// Single-instance in-memory queue (multi-instance horizontal scaling requires a shared queue / Redis, deferred for later).
// Entries only hold accountId + name + elo and no longer hold network connections — matchsvc is a private brain unreachable by players;
// players interact indirectly through the gateway.

export interface QueueEntry {
  accountId: string;
  name: string;
  /** 9-digit numeric public ID (UI display only; defaults to empty string). */
  publicId: string;
  /** Equipped title ID (from meta /internal/profile; empty string = no title). */
  equippedTitle: string;
  elo: number;
  enqueuedAt: number;
  /** Platform (used for feature flag targeted evaluation; defaults to empty string). */
  platform: string;
  /** PvP deck (card ids; validated and resolved by gateway; defaults to empty = matchsvc substitutes defaultPvpDeck at startMatch). */
  deck: string[];
  /**
   * Timestamp (ms) of the last bot-fallback timeout callback firing. Default = never fired (first check uses enqueuedAt).
   * Not fire-once: when the flag is off the entry stays in queue and is re-evaluated every botFallbackMs (throttled to avoid firing every tick),
   * so operators enabling the flag later can still cover entries that were already queued.
   */
  lastTimeoutAt?: number;
}

export interface MatchmakingOpts {
  /** Initial acceptable ELO difference window (half-width). Default 100. */
  baseWindow?: number;
  /** Amount to widen the window per second of waiting. Default 50. */
  widenPerSec?: number;
  /** Matchmaking scan interval in ms. Default 1000. */
  tickMs?: number;
  /** Injected clock (for testing). Default Date.now. */
  now?: () => number;
  /** Whether to automatically start the timer for periodic scanning. Default true; tests may disable and call tick() manually. */
  autoTick?: boolean;
  /**
   * If a player has been queued longer than this many milliseconds without being matched, onTimeout is fired (bot-fallback decision point).
   * 0 / unset = timeout detection disabled.
   * Note: timeout detection also applies to a single player waiting alone in the queue (the typical scenario for AI fallback).
   */
  botFallbackMs?: number;
  /** Timeout callback (fired once per entry). Whether to actually fall back is decided by the caller based on feature flags. */
  onTimeout?: (entry: QueueEntry) => void;
}

export class Matchmaking {
  private queue: QueueEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  private readonly baseWindow: number;
  private readonly widenPerSec: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly autoTick: boolean;
  private readonly botFallbackMs: number;
  private readonly onTimeout?: (entry: QueueEntry) => void;

  constructor(
    /** Callback on successful pair: this class handles removal from the queue; room creation is handled by the caller. */
    private readonly onPair: (a: QueueEntry, b: QueueEntry) => void,
    opts: MatchmakingOpts = {},
  ) {
    this.baseWindow = opts.baseWindow ?? 100;
    this.widenPerSec = opts.widenPerSec ?? 50;
    this.tickMs = opts.tickMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.autoTick = opts.autoTick ?? true;
    this.botFallbackMs = opts.botFallbackMs ?? 0;
    if (opts.onTimeout) this.onTimeout = opts.onTimeout;
  }

  has(accountId: string): boolean {
    return this.queue.some((e) => e.accountId === accountId);
  }

  get size(): number {
    return this.queue.length;
  }

  /** Enqueue (re-enqueuing the same account replaces the old entry and resets the wait timer). Attempts one pairing pass after enqueuing. */
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', platform = '', deck: string[] = []): void {
    this.remove(accountId);
    this.queue.push({ accountId, name, publicId, equippedTitle, elo, enqueuedAt: this.now(), platform, deck });
    this.ensureTimer();
    this.tick();
  }

  /** Dequeue (cancel matchmaking / disconnect / already paired). Stops the scan timer when the queue becomes empty. */
  remove(accountId: string): void {
    this.queue = this.queue.filter((e) => e.accountId !== accountId);
    if (this.queue.length === 0) this.stopTimer();
  }

  /**
   * One pairing pass: sorted by ELO ascending, adjacent pairs are matched if the difference is ≤ the window
   * (the window of whichever of the two has waited longer is used).
   * Greedy adjacent pairing on a score-sorted queue is good enough and starvation-free.
   */
  tick(): void {
    const t = this.now();

    // ── 1) ELO proximity pairing (only meaningful with queue size ≥2) ──
    if (this.queue.length >= 2) {
      const sorted = [...this.queue].sort((a, b) => a.elo - b.elo);
      const paired = new Set<string>();
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i]!;
        const b = sorted[i + 1]!;
        if (paired.has(a.accountId) || paired.has(b.accountId)) continue;
        const window = Math.max(this.windowFor(a, t), this.windowFor(b, t));
        if (Math.abs(a.elo - b.elo) <= window) {
          paired.add(a.accountId);
          paired.add(b.accountId);
        }
      }
      if (paired.size > 0) {
        const pairs: [QueueEntry, QueueEntry][] = [];
        const sortedPaired = sorted.filter((e) => paired.has(e.accountId));
        for (let i = 0; i + 1 < sortedPaired.length; i += 2) {
          pairs.push([sortedPaired[i]!, sortedPaired[i + 1]!]);
        }
        this.queue = this.queue.filter((e) => !paired.has(e.accountId));
        if (this.queue.length === 0) this.stopTimer();
        for (const [a, b] of pairs) this.onPair(a, b);
      }
    }

    // ── 2) bot-fallback timeout scan (for entries still in queue, including solo waiters) ──
    // Not fire-once: when the flag is off the entry stays in queue after the callback returns,
    // and is re-evaluated every botFallbackMs (throttled), so operators enabling match_bot_fallback later
    // can still cover entries already in the queue (the old fire-once design would miss them).
    // Collect first, then fire callbacks (callbacks may remove entries → avoid mutating the collection while iterating).
    if (this.onTimeout && this.botFallbackMs > 0 && this.queue.length > 0) {
      const due = this.queue.filter((e) => t - (e.lastTimeoutAt ?? e.enqueuedAt) >= this.botFallbackMs);
      for (const e of due) e.lastTimeoutAt = t;
      for (const e of due) this.onTimeout(e);
    }
  }

  clear(): void {
    this.queue = [];
    this.stopTimer();
  }

  private windowFor(e: QueueEntry, t: number): number {
    const waitSec = Math.max(0, (t - e.enqueuedAt) / 1000);
    return this.baseWindow + waitSec * this.widenPerSec;
  }

  private ensureTimer(): void {
    if (!this.autoTick || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
