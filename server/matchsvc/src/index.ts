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
import { createLogger, startHeartbeat, FeatureFlagCache, internalHeaders, loadInternalAuth } from '@nw/shared';

const log = createLogger('matchsvc:flags');

function main(): void {
  const env = loadMatchsvcEnv();

  // 功能开关缓存：轮询 admin 原始规则 + 本地求值（不连库，30s 刷新，admin 不可达吃旧缓存）。
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
  startHeartbeat(createLogger('matchsvc')); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main();
