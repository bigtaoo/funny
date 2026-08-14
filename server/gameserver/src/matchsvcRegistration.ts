// Startup registration + retry with matchsvc (extracted from index.ts so it can be unit tested
// without importing index.ts itself — index.ts calls `main()` unconditionally at module load,
// which would spin up a real http/WebSocket server as a side effect of merely importing it).
import { internalHeaders } from '@nw/shared';
import type { GameEnv } from './config';

/**
 * Registers this instance with matchsvc's GameRegistry so it starts receiving assigned matches.
 * Retries indefinitely on network failure / non-2xx-non-4xx responses (exponential backoff,
 * capped at 30s) — heartbeat does NOT re-register (GameRegistry.heartbeat drops unknown
 * gameIds), so a lost register would otherwise leave this instance permanently absent from the
 * registry (startup race vs matchsvc), with only the static fallback masking it. A 4xx response
 * is treated as a config/auth error that retrying won't fix, so it gives up immediately.
 *
 * No-op when either matchsvc's internal URL or this instance's public WS URL isn't configured
 * (single-instance deployments fall back to a static gameserver address).
 */
export async function registerWithMatchsvc(env: GameEnv): Promise<void> {
  if (!env.matchsvcInternalUrl || !env.publicWsUrl) return;
  const headers = { 'content-type': 'application/json', ...internalHeaders('gameserver', env.internalKey) };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${env.matchsvcInternalUrl}/mm/game/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ gameId: env.gameId, wsUrl: env.publicWsUrl, capacity: env.capacity }),
        signal: AbortSignal.timeout(5000),
      });
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
      if (res.ok) {
        console.log(`[gameserver] registered with matchsvc as ${env.gameId} (${env.publicWsUrl})`);
        return;
      }
      console.warn(`[gameserver] matchsvc register rejected (status ${res.status})`);
      if (res.status >= 400 && res.status < 500) return; // auth/config error — retrying won't help
    } catch (e) {
      console.warn('[gameserver] matchsvc register failed:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4))));
  }
}

/**
 * One periodic load heartbeat POST (extracted from index.ts's `setInterval` body). Best-effort:
 * matchsvc's GameRegistry.heartbeat drops unknown gameIds rather than erroring, and a single
 * missed beat self-heals on the next interval tick — so failures are swallowed, not retried here.
 * No-op when matchsvc's internal URL isn't configured (single-instance/static-fallback deployments).
 */
export async function reportLoadHeartbeat(env: GameEnv, load: number): Promise<void> {
  if (!env.matchsvcInternalUrl) return;
  try {
    const res = await fetch(`${env.matchsvcInternalUrl}/mm/game/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gameserver', env.internalKey) },
      body: JSON.stringify({ gameId: env.gameId, load }),
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
  } catch {
    /* retry on next cycle */
  }
}
