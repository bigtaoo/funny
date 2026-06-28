// gateway 进程引导（S1-M1；S1-M5 起 matchsvc 拆为独立进程）。
//   • 对外暴露公开控制面 WS（/gw），玩家经此建房/匹配；
//   • 把玩家控制命令转发给 matchsvc（独立进程，MatchsvcClient 内部 HTTP）；
//   • 内部 HTTP（/gw/push）接收 matchsvc 回推的事件 → 据 accountId 推给玩家 socket；
//   • ranked 入队前向 meta 取 ELO 带入。
//
// 反代：/gw → 本进程公开 WS 端口；内部 HTTP 端口不暴露。
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

  // 宗门频道实时推送（S8-4b）：订阅 Redis，把 worldsvc 扇出的 push 投给本机在线收件人。
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
  startHeartbeat(createLogger('gateway')); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main().catch((e) => {
  console.error('gateway failed to start:', e);
  process.exit(1);
});
