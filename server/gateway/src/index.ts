// gateway process bootstrap (S1-M1; matchsvc split into a separate process from S1-M5).
//   • Exposes the public control-plane WS (/gw); players use it to create rooms and match;
//   • Forwards player control commands to matchsvc (separate process, MatchsvcClient internal HTTP);
//   • Internal HTTP (/gw/push) receives events pushed back from matchsvc → delivers them to player sockets by accountId;
//   • Fetches ELO from meta before enqueueing for ranked and passes it along.
//
// Reverse proxy: /gw → this process's public WS port; internal HTTP port is not exposed.
import { loadInternalAuth, createLogger, startHeartbeat, type JwtConfig } from '@nw/shared';
import { loadGatewayEnv } from './config';
import { Gateway } from './Gateway';
import { MatchsvcClient } from './matchsvcClient';
import { MetaClient } from './metaClient';
import { SocialsvcClient } from './socialsvcClient';
import { startInternalHttp } from './internalHttp';
import { connectGatewaySubscriber, type GatewaySubscriber } from './redis';

async function main(): Promise<void> {
  const env = loadGatewayEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const meta = new MetaClient(env.metaBaseUrl, env.internalKey);
  const matchsvc = new MatchsvcClient(env.matchsvcInternalUrl, env.internalKey);
  const socialsvc = new SocialsvcClient(env.socialsvcInternalUrl, env.internalKey);
  const gateway = new Gateway({ host: env.host, port: env.port }, jwt, matchsvc, meta, socialsvc);

  const internal = startInternalHttp(
    { host: '0.0.0.0', port: env.internalPort, internalAuth: loadInternalAuth(env.internalKey) },
    gateway,
  );

  // Sect channel real-time push (S8-4b): subscribe to Redis and deliver worldsvc fan-out pushes to online recipients on this instance.
  const subscriber: GatewaySubscriber | null = await connectGatewaySubscriber(
    env.redisUrl,
    gateway.routeBroadcast,
  );

  const shutdown = (): void => {
    gateway.close();
    internal.close();
    if (subscriber) void subscriber.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`gateway control-plane WS on ws://${env.host}:${env.port}/gw`);
  console.log(`gateway internal HTTP on :${env.internalPort} (matchsvc /gw/push)`);
  console.log(
    `matchsvc: ${matchsvc.available ? env.matchsvcInternalUrl : 'unavailable (rooms/match disabled)'}; ` +
      `meta ELO: ${meta.available ? env.metaBaseUrl : 'unavailable (ranked disabled)'}; ` +
      `socialsvc presence: ${socialsvc.available ? env.socialsvcInternalUrl : 'off (fallback to meta)'}; ` +
      `redis push fan-out: ${subscriber ? 'on' : 'off'}`,
  );
  startHeartbeat(createLogger('gateway')); // Liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  console.error('gateway failed to start:', e);
  process.exit(1);
});
