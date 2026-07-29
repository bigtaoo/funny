// matchsvc process bootstrap (S1-M5): standalone process, private matchmaking brain not reachable by players.
//   • Internal HTTP (gateway control commands + gameserver register/heartbeat, not exposed to the public internet);
//   • Pushes async events (room_state / match_found) back to gateway → players via GatewayClient;
//   • Signs match tickets (shares NW_INTERNAL_KEY with gateway / gameserver).
//
// Reverse proxy does not expose matchsvc; only gateway / gameserver can reach it via the internal network.
import { loadMatchsvcEnv } from './config';
import { Matchsvc } from './Matchsvc';
import { GameRegistry } from './GameRegistry';
import { GatewayClient } from './gatewayClient';
import { startInternalHttp } from './internalHttp';
import { createLogger, startHeartbeat, FeatureFlagCache, fetchInternalJson, loadInternalAuth, connectActiveMatchRedis } from '@nw/shared';

const log = createLogger('matchsvc:flags');

async function main(): Promise<void> {
  const env = loadMatchsvcEnv();
  const redis = await connectActiveMatchRedis(env.redisUrl);

  // Feature flag cache: polls admin for raw rules + evaluates locally (no DB connection, refreshed every 30s; stale cache used when admin is unreachable).
  const adminUrl = env.adminInternalUrl;
  const flags = new FeatureFlagCache({
    fetchAll: async () => {
      if (!adminUrl) return [];
      // Bounded deadline so a wedged admin can't hang the 30s poll loop; throwing on
      // failure keeps the FeatureFlagCache "stale cache on error" semantics (onError).
      const r = await fetchInternalJson<{ flags?: unknown[] }>(`${adminUrl}/admin/internal/flags`, {
        caller: 'matchsvc',
        key: env.internalKey,
        timeoutMs: 5000,
        label: 'admin /admin/internal/flags',
      });
      if (!r.ok) throw new Error(`admin flags ${r.status ? String(r.status) : r.error ?? 'network error'}`);
      const flags = r.body?.flags;
      return Array.isArray(flags) ? flags : [];
    },
    ...(env.region ? { region: env.region } : {}),
    onError: (e) => log.warn('flag refresh failed (keeping cache)', { err: (e as Error).message }),
  });
  if (adminUrl) void flags.start();

  const games = new GameRegistry(Date.now, env.gamePublicWsUrl);
  // Reuses the same Redis connection as active-match tracking to publish gateway pushes via the
  // shared fan-out channel (GW_PUSH_REDIS_CHANNEL) instead of one fixed gateway address — correct
  // regardless of how many gateway instances are running (see gatewayClient.ts).
  const gateway = new GatewayClient(env.gatewayInternalUrl, env.internalKey, redis);
  const matchsvc = new Matchsvc(gateway.push, games, env.internalKey, {
    ticketTtlSec: env.ticketTtlSec,
    flags,
    botFallbackMs: env.botFallbackMs,
    redis,
  });

  // matchsvc-prematch-persist (2026-07-29): rebuild rooms/queue/duel invites from Redis (no-op when
  // redis is null) BEFORE accepting internal HTTP traffic — gateway/gameserver must never observe a
  // matchsvc that's up but hasn't finished reconstructing its in-memory state yet.
  await matchsvc.rehydrate();

  const internal = startInternalHttp(
    { host: env.host, port: env.internalPort, internalAuth: loadInternalAuth(env.internalKey) },
    matchsvc,
  );

  const shutdown = (): void => {
    internal.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`matchsvc internal HTTP on :${env.internalPort} (gateway commands + game register/heartbeat)`);
  console.log(
    `gateway push: ${redis ? 'redis fan-out (multi-instance safe)' : gateway.available ? `direct HTTP ${env.gatewayInternalUrl} (single-instance only)` : 'unavailable (events dropped)'}; ` +
      `game fallback: ${env.gamePublicWsUrl ?? 'none (register required)'}`,
  );
  console.log(
    `feature flags: ${adminUrl ? `poll ${adminUrl} (region=${env.region ?? 'none'})` : 'disabled (all default)'}; ` +
      `bot-fallback after ${env.botFallbackMs}ms`,
  );
  console.log(`active-match redis: ${redis ? 'connected' : 'disabled (resume-prompt data not persisted)'}`);
  console.log(`pre-match persistence (rooms/queue/duel invites): ${redis ? 'connected (rehydrated on startup)' : 'disabled (pure in-memory, resets on restart)'}`);
  startHeartbeat(createLogger('matchsvc')); // Liveness heartbeat: one info log every 5 minutes when idle
}

void main();
