// Server clock offset (P1-1, comm-audit-2026-07-27). All SLG/economy countdowns (march ETA, build/
// train queue, siege timers, subscription expiry, speedup pricing) previously compared a server
// epoch timestamp against the client's own `Date.now()` with zero correction — a client with a fast
// or slow local clock would show a countdown that's systematically off, or (worse) compute a wrong
// speedup price against the server's actual remaining time. There was no mechanism to detect or
// correct this drift.
//
// Every response that already carries an authoritative server timestamp (getSave/getMe/auth) now also
// sends `serverNow` (the server's own `now()` at response time); `sample()` below records the offset
// between that and the client's local clock at receipt. `serverNow()` is the corrected "current time"
// to use for any comparison against a server-issued epoch timestamp (completeAt/arriveAt/expiresAt/…).
//
// Single shared instance (not per-ApiClient) — there is only one wall clock to correct, and both the
// meta (ApiClient) and worldsvc (WorldApiClient) response paths sample into the same offset.

let offsetMs = 0;
let sampled = false;

/** Record a fresh offset sample from a response that carried `serverNow`. Call at receipt time (not
 *  after any awaited work) so the round-trip latency it implicitly absorbs stays small. */
export function sampleServerNow(serverNow: number): void {
  offsetMs = serverNow - Date.now();
  sampled = true;
}

/** Best-effort corrected "now" — falls back to the raw local clock before the first sample arrives
 *  (i.e. before any authenticated request completes), which matches prior behavior exactly. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Whether at least one sample has been taken (mainly for tests). */
export function hasServerClockSample(): boolean {
  return sampled;
}

/** Test-only reset. */
export function resetServerClock(): void {
  offsetMs = 0;
  sampled = false;
}
