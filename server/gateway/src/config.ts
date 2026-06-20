// gateway 环境变量（复用 @nw/shared ServerEnv：jwtSecret 验客户端 token，internalKey 内部鉴权）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface GatewayEnv extends ServerEnv {
  /** 公开控制面 WS 端口（反代 /gw → 此端口）。 */
  port: number;
  host: string;
  /** 内部 HTTP 端口（matchsvc 经 /gw/push 推事件回来 → 此端口；不暴露公网）。 */
  internalPort: number;
  /** meta REST 基址（取 ELO：GET {metaBaseUrl}/internal/elo）。无则 ranked 不可用。 */
  metaBaseUrl: string | null;
  /** matchsvc 内部 HTTP 基址（转发玩家控制命令）。null = 联机不可用。 */
  matchsvcInternalUrl: string | null;
  /** Redis 连接串（S8-4b，订阅 GW_PUSH_REDIS_CHANNEL 做宗门频道扇出）；缺省 = 实时推送降级。 */
  redisUrl: string | undefined;
}

export function loadGatewayEnv(): GatewayEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GW_PORT ?? 8082),
    host: process.env.NW_GW_HOST ?? '0.0.0.0',
    internalPort: Number(process.env.NW_GW_INTERNAL_PORT ?? 8090),
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    matchsvcInternalUrl: process.env.NW_MATCHSVC_INTERNAL_URL ?? null,
    redisUrl: process.env.NW_GW_REDIS_URL || undefined,
  };
}
