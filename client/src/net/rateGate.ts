// Global outbound request throttle: caps the client's total request rate across all three
// transports (metaserver REST / worldsvc REST / WS business messages) so a slow or unresponsive
// server can't be hammered by repeated clicks or a runaway retry loop. Token bucket: allows a
// short burst up to `capacity`, then settles to a steady `capacity` per `refillMs * capacity` window.
// Callers await acquire() before sending; on saturation the call just waits its turn in FIFO order
// instead of failing — this is a smoothing throttle, not a hard rejection.
const CAPACITY = 5;
const REFILL_MS = 200; // 1 token every 200ms → steady-state 5 req/sec

export class RateGate {
  private tokens = CAPACITY;
  private readonly queue: Array<() => void> = [];
  /**
   * The refill interval, or `null` while the bucket is full and nothing is waiting.
   *
   * It used to be started unconditionally in the constructor and never cleared, so a client sitting
   * on a menu with zero outbound traffic still woke the main thread 5 times a second, forever. That
   * was invisible next to the 60 Hz full-stage repaint it shared a thread with; after ADR-083 the
   * idle client repaints 5-12 times a second, and this timer became a comparable share of what is
   * left. A full bucket has nothing to refill, so there is nothing for the tick to do either.
   */
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Synchronous fast path: grabs a token immediately if the budget isn't exhausted, with no
   * microtask hop. NetClient.sendClient relies on this to keep sending under budget exactly as
   * synchronous as it was before the rate gate existed (a caller reading its fake socket's `sent`
   * array right after a send call must not observe it as still-pending).
   */
  tryAcquire(): boolean {
    if (this.tokens > 0 && this.queue.length === 0) {
      this.tokens--;
      this.startRefill();
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push(resolve);
      // A waiter can be queued with the bucket already drained by `tryAcquire`, in which case the
      // timer is running; but also by a second `acquire` after the queue formed, where it may not be.
      this.startRefill();
    });
  }

  /**
   * Arm the refill interval if it isn't already. Called on every consumption rather than once at
   * construction: the interval's phase then starts at the moment a token was spent, which makes the
   * first refill land exactly `REFILL_MS` later instead of anywhere within the previous window —
   * stricter than before, never looser, and the steady-state rate is unchanged.
   */
  private startRefill(): void {
    if (this.refillTimer !== null) return;
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(CAPACITY, this.tokens + 1);
      this.pump();
      // Back to a full bucket with nobody waiting: nothing for further ticks to do. The next
      // consumption arms it again.
      if (this.tokens >= CAPACITY && this.queue.length === 0) this.stopRefill();
    }, REFILL_MS);
  }

  private stopRefill(): void {
    if (this.refillTimer === null) return;
    clearInterval(this.refillTimer);
    this.refillTimer = null;
  }

  private pump(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      this.queue.shift()!();
    }
  }
}

/** Shared across ApiClientCore, WorldApiClient, and NetClient's rate-limited WS messages. */
export const globalRequestGate = new RateGate();
