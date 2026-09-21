/**
 * The telemetry session id — one value, shared by the two pipelines that report on a running client.
 *
 * Why it is not simply a field inside `analytics/index.ts` any more: the game reports on itself
 * through two independent channels that never had a key in common. Analytics events carry
 * `session_id` (batch meta) and land in Mongo; anomaly/crash reports carry `publicId` and land in
 * Loki. `publicId` does not exist until the player is logged in, and it identifies a *player*, not a
 * *run of the app* — so "the session that died at 14:02 is the one that stopped sending events at
 * 14:02" was a claim nobody could check. It had to be inferred from two clocks and a platform
 * string, which for anything below a few hundred concurrent players is guesswork.
 *
 * So the id is created here instead, eagerly on first read, and both channels stamp it:
 * `analytics/index.ts` as `session_id`, `net/anomaly/reporter.ts` as `sid`. Grafana's
 * `{source="client",kind="anomaly"} | logfmt | sid="<id>"` and a Mongo query on `session_id` then
 * name the same run of the app.
 *
 * It lives in its own module rather than in `analytics/index.ts` for ordering reasons: the crash
 * sentinel runs during `startApp()`, long before `analytics.init()` creates a queue, and reading the
 * id must not depend on analytics having been initialised (or on it being enabled at all — an
 * offline build never calls `init`, and its crash reports still deserve a stable id).
 */

/** Lazily created so a module import alone starts nothing; every reader shares the first value. */
let sessionId: string | null = null;

function generate(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** This run of the app, as both telemetry channels name it. Stable for the process lifetime. */
export function telemetrySessionId(): string {
  if (sessionId === null) sessionId = generate();
  return sessionId;
}

/** Test seam: forget the current id so the next read mints a fresh one. Never called by app code. */
export function resetTelemetrySessionId(): void {
  sessionId = null;
}
