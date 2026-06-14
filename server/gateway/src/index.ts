// gateway 进程引导（S1-M1）：前期 gateway + matchsvc 合一进程。
//   • 对外暴露公开控制面 WS（/gw），玩家经此建房/匹配；
//   • 内部 HTTP（game 注册/心跳，不暴露公网）；
//   • matchsvc 进程内模块（玩家不可达），事件经 gateway.push 回推玩家。
//
// 反代：/gw → 本进程公开 WS 端口；内部 HTTP 端口不暴露。
import type { JwtConfig } from '@nw/shared';
import { loadGatewayEnv } from './config';
import { Gateway } from './Gateway';
import { Matchsvc } from './matchsvc/Matchsvc';
import { GameRegistry } from './matchsvc/GameRegistry';
import { MetaClient } from './metaClient';
import { startInternalHttp } from './internalHttp';

function main(): void {
  const env = loadGatewayEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const meta = new MetaClient(env.metaBaseUrl, env.internalKey);
  const games = new GameRegistry(Date.now, env.gamePublicWsUrl);

  // matchsvc 需要 push 回调，gateway 需要 matchsvc → 先建 gateway 持有者再回填。
  let gatewayRef: Gateway | null = null;
  const matchsvc = new Matchsvc(
    (accountId, msg) => gatewayRef?.push(accountId, msg),
    games,
    env.internalKey,
    { ticketTtlSec: env.ticketTtlSec },
  );
  const gateway = new Gateway({ host: env.host, port: env.port }, jwt, matchsvc, meta);
  gatewayRef = gateway;

  const internal = startInternalHttp(
    { host: '0.0.0.0', port: env.internalPort, internalKey: env.internalKey },
    matchsvc,
  );

  const shutdown = (): void => {
    gateway.close();
    internal.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`gateway control-plane WS on ws://${env.host}:${env.port}/gw`);
  console.log(`gateway internal HTTP on :${env.internalPort} (game register/heartbeat)`);
  console.log(
    `meta ELO: ${meta.available ? env.metaBaseUrl : 'unavailable (ranked disabled)'}; ` +
      `game fallback: ${env.gamePublicWsUrl ?? 'none (register required)'}`,
  );
}

main();
