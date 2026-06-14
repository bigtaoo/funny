// gateway 环境变量（复用 @nw/shared ServerEnv：jwtSecret 验客户端 token，internalKey 签 ticket）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface GatewayEnv extends ServerEnv {
  /** 公开控制面 WS 端口（反代 /gw → 此端口）。 */
  port: number;
  host: string;
  /** 内部 HTTP 端口（game 注册/心跳 → 此端口；不暴露公网）。 */
  internalPort: number;
  /** meta REST 基址（取 ELO：GET {metaBaseUrl}/internal/elo）。无则 ranked 不可用。 */
  metaBaseUrl: string | null;
  /**
   * 静态 game 实例兜底地址（单实例部署）。game 未注册时直接用它分配。
   * 形如 ws://host:8081/ws 或 wss://domain/ws。
   */
  gamePublicWsUrl: string | null;
  /** ticket 有效期秒数（match_found 到连 game 的容忍窗口）。默认 30。 */
  ticketTtlSec: number;
}

export function loadGatewayEnv(): GatewayEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GW_PORT ?? 8082),
    host: process.env.NW_GW_HOST ?? '0.0.0.0',
    internalPort: Number(process.env.NW_GW_INTERNAL_PORT ?? 8090),
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    gamePublicWsUrl: process.env.NW_GAME_PUBLIC_WS_URL ?? null,
    ticketTtlSec: Number(process.env.NW_TICKET_TTL_SEC ?? 30),
  };
}
