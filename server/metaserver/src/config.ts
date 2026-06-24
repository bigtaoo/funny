import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MetaEnv extends ServerEnv {
  port: number;
  host: string;
  /** commercial 内部 HTTP 基址（钱包/扣币/盲盒/充值/广告）。null = 经济端点不可用（503）。 */
  commercialUrl: string | null;
  /** gateway 内部 HTTP 基址（对等裁判 /gw/judge）。null = 裁判不可用（ranked 不一致直接作废）。 */
  gatewayInternalUrl: string | null;
  /**
   * gateway 公开控制面 WS 地址（客户端连这里做房间/匹配），由 auth/save 回包下发给客户端。
   * 客户端只硬编码 meta 地址，gateway/game 地址都实时获取——gateway 走这里、game 走 match_found。
   * null = 不下发（客户端退回自身配置/推导）。形如 ws://host:8082/gw 或 wss://host/gw。
   */
  gatewayPublicUrl: string | null;
  /** 成就反作弊离线抽查批间隔（ms）。0 = 禁用（缺省 60000）。需配 gatewayInternalUrl 才有裁判可复算。 */
  auditIntervalMs: number;
  /** 每次抽查批检视的候选 ranked 局数（缺省 5）。 */
  auditSampleLimit: number;
  /**
   * 每 IP 15 分钟内允许的最大 auth 尝试次数（register/login/oauth）。
   * 0 = 禁用限流（测试/CI 环境用）。默认 20。
   */
  authRateLimit: number;
  /** admin 内部基址（轮询 GET /admin/internal/flags 拿 feature flag 原始规则；供公开 /bootstrap 求值）。null = 不读 flag（全 default → bootstrap 恒空 map）。 */
  adminInternalUrl: string | null;
  /** 部署区域（注入 feature flag 求值 ctx）。空 = 不按区定向。 */
  region: string | null;
  /**
   * Loki push API 地址（POST /client/log 转发客户端日志至此，FEATURE_FLAGS_DESIGN §9.4）。
   * null = 不转发（静默丢弃）。形如 http://loki:3100/loki/api/v1/push；需 metaserver 容器能解析到
   * loki（obs 栈独立网络，见 observability/README.md「网络坑」）。不可达 → 静默丢弃，绝不影响玩家。
   */
  lokiPushUrl: string | null;
}

export function loadMetaEnv(): MetaEnv {
  return {
    ...loadServerEnv(),
    // 默认 18080：Windows(Hyper-V/WSL)常把 8080 纳入 netsh 保留端口段，listen 报 EACCES。
    port: Number(process.env.NW_META_PORT ?? 18080),
    host: process.env.NW_META_HOST ?? '0.0.0.0',
    commercialUrl: process.env.NW_COMMERCIAL_INTERNAL_URL ?? null,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    gatewayPublicUrl: process.env.NW_GATEWAY_PUBLIC_WS_URL ?? null,
    auditIntervalMs: Number(process.env.NW_ACHIEVEMENT_AUDIT_INTERVAL_MS ?? 60000),
    auditSampleLimit: Number(process.env.NW_ACHIEVEMENT_AUDIT_SAMPLE_LIMIT ?? 5),
    authRateLimit: Number(process.env.NW_AUTH_RATE_LIMIT ?? 20),
    adminInternalUrl: process.env.NW_ADMIN_INTERNAL_URL ?? null,
    region: process.env.NW_REGION ?? null,
    lokiPushUrl: process.env.NW_LOKI_PUSH_URL ?? null,
  };
}
