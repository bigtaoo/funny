// Internal service-to-service POST with the reliability the bare fire-and-forget
// `void fetch().then(res => …)` pattern lacked. That pattern was proven (ranked load
// smoke, 0/20 paired) to wedge undici's keep-alive pool under a concurrent burst:
// the gateway fired ~20 enqueue POSTs at matchsvc, none consumed the response body,
// the sockets stayed checked-out, the pool jammed, and every POST eventually failed
// with `fetch failed` ~30s later — so no enqueue ever reached matchsvc. See
// observability/README.md "troubleshooting checklist" and SERVER_API.md "internal authentication model".
//
// Three fixes, all applied here so callers can't forget them:
//   1. ALWAYS drain/cancel the response body, even though these calls return their
//      real result asynchronously (via the reverse push channel), not in the HTTP
//      response. An unconsumed undici body keeps its socket out of the pool.
//   2. Explicit per-attempt timeout (undici fetch has NO default → a stuck socket
//      hangs tens of seconds instead of failing fast and freeing up).
//   3. Optional bounded exponential-backoff retry for the NON-self-healing commands
//      (enqueue / match_found / leave): losing one strands the player, and nobody
//      re-sends it (the client's ranked-queue guard fires once; matchsvc already
//      dequeued + signed the ticket). Retry is safe because the receivers are
//      idempotent — matchsvc.enqueue dedups by accountId, the client dedups
//      match_found by ticket (NetSession.connectGame). Self-healing messages
//      (room_state snapshots, presence) take retries=0: the next change re-sends.
import { internalHeaders, type InternalCaller } from './internalAuth';
import type { Logger } from './logger';

export interface InternalPostOpts {
  /** Calling service (selects the per-caller key + sets x-internal-caller). */
  caller: InternalCaller;
  /** Legacy shared key; internalHeaders upgrades it to the per-caller key if registered. */
  key: string;
  /** Per-attempt timeout (ms). Default 5000. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt (0 = single shot). Use >0 only for idempotent, non-self-healing commands. */
  retries?: number;
  /** Base backoff (ms): delay = backoffMs * 2^attempt + jitter. Default 150. */
  backoffMs?: number;
  /** Logger for failure warn/error (optional). */
  log?: Logger;
  /** Human label for logs (usually the path). Defaults to the url. */
  label?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * POST `body` as JSON to an internal endpoint. Returns true iff a 2xx came back.
 * Never throws — failures are logged (if a logger is given) and reported via the
 * boolean. Drains the response body and bounds each attempt with a timeout; retries
 * transient failures (network error / 5xx) up to `retries` times. A 4xx is treated
 * as terminal (bad request / auth) and never retried.
 */
export async function postInternal(url: string, body: unknown, opts: InternalPostOpts): Promise<boolean> {
  const { caller, key, timeoutMs = 5000, retries = 0, backoffMs = 150, log, label = url } = opts;
  const headers = { 'content-type': 'application/json', ...internalHeaders(caller, key) };
  const payload = JSON.stringify(body);
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      // Release the socket back to the pool — leaving the body unconsumed is the
      // exact leak that wedged the pool under burst (see file header).
      try {
        await res.body?.cancel();
      } catch {
        /* already consumed / closed */
      }
      if (res.ok) return true;
      lastErr = `status ${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        log?.warn('internal POST rejected (no retry)', { path: label, status: res.status });
        return false; // client error — retry won't help
      }
      // 5xx falls through to retry
    } catch (e) {
      lastErr = (e as Error).message; // network error / timeout / abort
    }
    if (attempt < retries) await sleep(backoffMs * 2 ** attempt + Math.floor(Math.random() * backoffMs));
  }
  log?.error('internal POST failed', { path: label, attempts: retries + 1, err: lastErr });
  return false;
}
