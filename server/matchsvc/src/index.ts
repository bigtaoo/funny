// matchsvc 进程引导（S1-M5）：独立进程，玩家不可达的私有匹配大脑。
//   • 内部 HTTP（gateway 控制命令 + gameserver 注册/心跳，不暴露公网）；
//   • 经 GatewayClient 把异步事件（room_state / match_found）推回 gateway → 玩家；
//   • 签 match ticket（与 gateway / gameserver 共用 NW_INTERNAL_KEY）。
//
// 反代不暴露 matchsvc；只有 gateway / gameserver 经内部网络可达。
import { loadMatchsvcEnv } from './config';
import { Matchsvc } from './Matchsvc';
import { GameRegistry } from './GameRegistry';
import { GatewayClient } from './gatewayClient';
import { startInternalHttp } from './internalHttp';
import { loadInternalAuth } from '@nw/shared';

function main(): void {
  const env = loadMatchsvcEnv();

  const games = new GameRegistry(Date.now, env.gamePublicWsUrl);
  const gateway = new GatewayClient(env.gatewayInternalUrl, env.internalKey);
  const matchsvc = new Matchsvc(gateway.push, games, env.internalKey, {
    ticketTtlSec: env.ticketTtlSec,
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
}

main();
