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
import { createLogger, startHeartbeat, FeatureFlagCache, internalHeaders, loadInternalAuth, connectActiveMatchRedis } from '@nw/shared';

const log = createLogger('matchsvc:flags');

async function main(): Promise<void> {
  const env = loadMatchsvcEnv();
  const redis = await connectActiveMatchRedis(env.redisUrl);

  // Feature flag cache: polls admin for raw rules + evaluates locally (no DB connection, refreshed every 30s; stale cache used when admin is unreachable).
  const adminUrl = env.adminInternalUrl;
  const flags = new FeatureFlagCache({
    fetchAll: async () => {
      if (!adminUrl) return [];
      const res = await fetch(`${adminUrl}/admin/internal/flags`, {
        headers: internalHeaders('matchsvc', env.internalKey),
      });
      if (!res.ok) throw new Error(`admin flags ${res.status}`);
      const body = (await res.json()) as { flags?: unknown[] };
      return Array.isArray(body.flags) ? body.flags : [];
    },
    ...(env.region ? { region: env.region } : {}),
    onError: (e) => log.warn('flag refresh failed (keeping cache)', { err: (e as Error).message }),
  });
  if (adminUrl) void flags.start();

  const games = new GameRegistry(Date.now, env.gamePublicWsUrl);
  const gateway = new GatewayClient(env.gatewayInternalUrl, env.internalKey);
  const matchsvc = new Matchsvc(gateway.push, games, env.internalKey, {
    ticketTtlSec: env.ticketTtlSec,
    flags,
    botFallbackMs: env.botFallbackMs,
    redis,
  });

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
    `gateway push: ${gateway.available ? env.gatewayInternalUrl : 'unavailable (events dropped)'}; ` +
      `game fallback: ${env.gamePublicWsUrl ?? 'none (register required)'}`,
  );
  console.log(
    `feature flags: ${adminUrl ? `poll ${adminUrl} (region=${env.region ?? 'none'})` : 'disabled (all default)'}; ` +
      `bot-fallback after ${env.botFallbackMs}ms`,
  );
  console.log(`active-match redis: ${redis ? 'connected' : 'disabled (resume-prompt data not persisted)'}`);
  startHeartbeat(createLogger('matchsvc')); // Liveness heartbeat: one info log every 5 minutes when idle
}

void main();
