// worldsvc 环境变量（S8-0，第七 workspace + 专属库）。
// SLG_DESIGN §14.1：worldsvc 自暴露公网 REST（第四公网面 /world/* /auction/*），
// 复用 meta JWT 仅 verifyToken 验签（不连 accounts 库）。内部事件经 gateway /gw/push 推回客户端。
// 注：/family/* 路由已迁至 socialsvc（第五公网面 /social/*），worldsvc 不再代理家族请求。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface WorldsvcEnv extends ServerEnv {
  /** 公网 REST 端口（反代 /world,/family,/auction → 此端口）。默认 18084（避开 Windows 保留段）。 */
  port: number;
  host: string;
  /** worldsvc 专属库 Mongo URI（默认复用 meta 同实例）。 */
  worldMongoUri: string;
  /** worldsvc 专属库名（与 meta/commercial/admin 物理隔离）。 */
  worldMongoDb: string;
  /** Redis 连接串（首次引入，S8-0）；缺省 = 无 Redis，行军调度/频道降级（S8-1/S8-4 才真正需要）。 */
  redisUrl: string | undefined;
  /** gateway 内部 HTTP 基址（worldsvc → /gw/push 推送实时事件）；缺省 = 不推送（仅 REST 轮询）。 */
  gatewayInternalUrl: string | undefined;
  /** commercial 内部 HTTP 基址（拍卖场 S8-5：买方扣币 / 卖方付款）；缺省 = 不支持金币交易。 */
  commercialInternalUrl: string | undefined;
  /** meta 内部 HTTP 基址（拍卖场 S8-5：材料扣除 / 发放）；缺省 = 不支持材料交易。 */
  metaInternalUrl: string | undefined;
  /** socialsvc 内部 HTTP 基址（频道推送委托）；缺省 = 不委托。 */
  socialsvcInternalUrl: string | undefined;
}

export function loadWorldsvcEnv(): WorldsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_WORLD_PORT ?? 18084),
    host: process.env.NW_WORLD_HOST ?? '0.0.0.0',
    worldMongoUri: process.env.NW_WORLD_MONGO_URI ?? base.mongoUri,
    worldMongoDb: process.env.NW_WORLD_MONGO_DB ?? 'notebook_wars_world',
    redisUrl: process.env.NW_WORLD_REDIS_URL || undefined,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL || undefined,
    commercialInternalUrl: process.env.NW_COMMERCIAL_INTERNAL_URL || undefined,
    metaInternalUrl: process.env.NW_META_INTERNAL_URL || undefined,
    socialsvcInternalUrl: process.env.NW_SOCIALSVC_INTERNAL_URL || undefined,
  };
}
