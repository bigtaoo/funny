// Graceful-shutdown sequencing, extracted from index.ts's inline `shutdown()` closure so the
// ordering (stop timers -> snapshot rosters -> destroy rooms -> stop accepting new
// connections/requests -> best-effort flush queued match reports -> exit) is unit-testable
// against fake manager/reporter/server objects instead of a real process + real sockets.
import type { RoomManager } from './RoomManager';
import type { MetaReporter } from './metaReport';

export interface ShutdownDeps {
  manager: Pick<RoomManager, 'activeAccountIds' | 'destroyAll'>;
  reporter: Pick<MetaReporter, 'flush' | 'abandon'>;
  /** Real `WebSocketServer`/`http.Server` only need `.close()` here. */
  wss: { close(): void };
  http: { close(): void };
  /** Timers started by index.ts (heartbeat sweep, matchsvc register-heartbeat) to clear on shutdown. */
  timers: Array<ReturnType<typeof setInterval>>;
  /** Bounded wait for the in-memory retry queue to drain (default matches the original 10s). */
  flushMaxWaitMs?: number;
  /** Injectable so tests don't actually exit the test process; defaults to `process.exit(0)`. */
  exit?: () => void;
}

/** Runs once. Safe to call concurrently — everything here is idempotent or a no-op the second time. */
async function runShutdown(deps: ShutdownDeps): Promise<void> {
  for (const t of deps.timers) clearInterval(t);
  // Capture before destroyAll() wipes the rooms (login-reconnect-prompt, 2026-07-28): any room
  // still in progress at shutdown never gets an end-of-match report, so its players' cached
  // "resume your match?" flag would otherwise linger (bounded only by the 1h TTL) and offer to
  // reconnect into a room this restart just destroyed.
  const abandonedAccountIds = deps.manager.activeAccountIds();
  deps.manager.destroyAll();
  deps.wss.close();
  deps.http.close();
  // Give queued (failed/timed-out) match reports a bounded chance to reach meta — the retry
  // queue is in-memory only, so exiting immediately loses those settlements.
  await Promise.all([
    deps.reporter.flush(deps.flushMaxWaitMs ?? 10_000),
    deps.reporter.abandon(abandonedAccountIds),
  ]);
  (deps.exit ?? (() => process.exit(0)))();
}

/**
 * Builds a SIGINT/SIGTERM-safe shutdown handler: both signals (or a signal racing a manual call)
 * firing in quick succession must only run the sequence once — `runShutdown` is not itself
 * re-entrancy-safe (e.g. `wss.close()`/`http.close()` twice, double `process.exit`).
 */
export function createShutdownHandler(deps: ShutdownDeps): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runShutdown(deps);
  };
}
