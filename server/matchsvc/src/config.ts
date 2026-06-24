// matchsvc 环境变量（S1-M5，独立进程）。只用 @nw/shared 的 internalKey（签 ticket + 内部鉴权）；
// 不连任何库、不验客户端 token（玩家不可达，只接 gateway / gameserver 的内部 HTTP）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MatchsvcEnv extends ServerEnv {
  /** 内部 HTTP 端口（gateway 控制命令 + gameserver 注册/心跳 → 此端口；不暴露公网）。 */
  internalPort: number;
  host: string;
  /** gateway 内部 HTTP 基址（matchsvc 把房间态/match_found 推回 gateway → 玩家）。null = 无法 push。 */
  gatewayInternalUrl: string | null;
  /** 静态 game 兜底地址（单实例部署，game 未注册时直接分配它）。 */
  gamePublicWsUrl: string | null;
  /** ticket 有效期秒数（match_found 到连 game 的容忍窗口）。默认 30。 */
  ticketTtlSec: number;
  /** admin 内部基址（轮询 GET /admin/internal/flags 拿 feature flag 原始规则）。null = 不读 flag（全 default）。 */
  adminInternalUrl: string | null;
  /** 部署区域（注入 feature flag 求值 ctx）。空 = 不按区定向。 */
  region: string | null;
  /** ranked 匹配等待超此毫秒数 → 评估 match_bot_fallback 决定是否降级打 AI。默认 30000。 */
  botFallbackMs: number;
}

export function loadMatchsvcEnv(): MatchsvcEnv {
  return {
    ...loadServerEnv(),
    internalPort: Number(process.env.NW_MM_INTERNAL_PORT ?? 8091),
    host: process.env.NW_MM_HOST ?? '0.0.0.0',
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    gamePublicWsUrl: process.env.NW_GAME_PUBLIC_WS_URL ?? null,
    ticketTtlSec: Number(process.env.NW_TICKET_TTL_SEC ?? 30),
    adminInternalUrl: process.env.NW_ADMIN_INTERNAL_URL ?? null,
    region: process.env.NW_REGION ?? null,
    botFallbackMs: Number(process.env.NW_MM_BOT_FALLBACK_MS ?? 30000),
  };
}
