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

  constructor() {
    setInterval(() => {
      this.tokens = Math.min(CAPACITY, this.tokens + 1);
      this.pump();
    }, REFILL_MS);
  }

  /**
   * Synchronous fast path: grabs a token immediately if the budget isn't exhausted, with no
   * microtask hop. NetClient.sendClient relies on this to keep sending under budget exactly as
   * synchronous as it was before the rate gate existed (a caller reading its fake socket's `sent`
   * array right after a send call must not observe it as still-pending).
   */
  tryAcquire(): boolean {
    if (this.tokens > 0 && this.queue.length === 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private pump(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      this.queue.shift()!();
    }
  }
}

/** Shared across ApiClientBase, WorldApiClient, and NetClient's rate-limited WS messages. */
export const globalRequestGate = new RateGate();
