// gateway 进程引导（S1-M1；S1-M5 起 matchsvc 拆为独立进程）。
//   • 对外暴露公开控制面 WS（/gw），玩家经此建房/匹配；
//   • 把玩家控制命令转发给 matchsvc（独立进程，MatchsvcClient 内部 HTTP）；
//   • 内部 HTTP（/gw/push）接收 matchsvc 回推的事件 → 据 accountId 推给玩家 socket；
//   • ranked 入队前向 meta 取 ELO 带入。
//
// 反代：/gw → 本进程公开 WS 端口；内部 HTTP 端口不暴露。
import type { JwtConfig } from '@nw/shared';
import { loadGatewayEnv } from './config';
import { Gateway } from './Gateway';
import { MatchsvcClient } from './matchsvcClient';
import { MetaClient } from './metaClient';
import { startInternalHttp } from './internalHttp';

function main(): void {
  const env = loadGatewayEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const meta = new MetaClient(env.metaBaseUrl, env.internalKey);
  const matchsvc = new MatchsvcClient(env.matchsvcInternalUrl, env.internalKey);
  const gateway = new Gateway({ host: env.host, port: env.port }, jwt, matchsvc, meta);

  const internal = startInternalHttp(
    { host: '0.0.0.0', port: env.internalPort, internalKey: env.internalKey },
    gateway,
  );

  const shutdown = (): void => {
    gateway.close();
    internal.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`gateway control-plane WS on ws://${env.host}:${env.port}/gw`);
  console.log(`gateway internal HTTP on :${env.internalPort} (matchsvc /gw/push)`);
  console.log(
    `matchsvc: ${matchsvc.available ? env.matchsvcInternalUrl : 'unavailable (rooms/match disabled)'}; ` +
      `meta ELO: ${meta.available ? env.metaBaseUrl : 'unavailable (ranked disabled)'}`,
  );
}

main();
