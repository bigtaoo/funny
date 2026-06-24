// Fastify 应用装配（与进程引导分离，便于测试/inject）。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import openapiGlue from 'fastify-openapi-glue';
import type { Collections, JwtConfig, FeatureFlagCache } from '@nw/shared';
import { createLogger, internalKeysFromEnv } from '@nw/shared';
import { MetaService } from './service.js';
import { registerAdCallbackRoutes } from './ads.js';

const log = createLogger('meta');
import { makeSecurityHandlers } from './auth.js';
import { registerInternalRoutes } from './internal.js';
import { HttpCommercialClient, type CommercialClient } from './commercialClient.js';
import { HttpGatewayClient, type GatewayClient } from './gatewayClient.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/app.js 与 src/app.ts 都在 metaserver 下两级 → contracts。
export const SPEC_PATH = resolve(here, '../../contracts/openapi.yml');

export interface BuildAppOpts {
  cols: Collections;
  jwt: JwtConfig;
  /** 内部服务鉴权密钥（gateway 取 ELO / gameserver 上报对局 / commercial 调用）。 */
  internalKey: string;
  /** commercial 内部基址（null = 经济端点 503）；或直接注入 client（测试用）。 */
  commercialUrl?: string | null;
  commercial?: CommercialClient;
  /** gateway 内部基址（对等裁判 /gw/judge；null = 裁判不可用）；或直接注入 client（测试用）。 */
  gatewayUrl?: string | null;
  gateway?: GatewayClient;
  /** gateway 公开 WS 地址，随 auth/save 回包下发给客户端（null = 不下发）。 */
  gatewayPublicUrl?: string | null;
  now?: () => number;
  logger?: boolean;
  /** 每 IP 15 分钟内最大 auth 尝试数（0 = 禁用，测试用）。默认 20。 */
  authRateLimit?: number;
  /** feature flag 缓存（公开 /bootstrap 求值用）。null/缺省 = 无 flag 源，bootstrap 恒回空 map。 */
  flags?: FeatureFlagCache | null;
  /** 部署区域（注入 flag 求值 ctx）。 */
  region?: string | null;
  /** Loki push 地址（POST /client/log 转发；null = 静默丢弃）。 */
  lokiPushUrl?: string | null;
}

export async function buildApp(opts: BuildAppOpts): Promise<FastifyInstance> {
  // bodyLimit 设 4MB（默认仅 1MB）：状态流分享上传压缩 blob（上限 2MB，service.ts），需让 Fastify
  // 体量闸 ≥ 应用层上限，否则 >1MB 的合法 blob 被 Fastify 抢先 413（FST_ERR_CTP_BODY_TOO_LARGE），
  // 应用层的优雅 400「replay too large」永不触发。其余端点 body 远小于此，不受影响。
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // 可读的请求/响应日志（联调用，替代 pino JSON）。每条请求一行收尾：方法 路径 状态 耗时。
  // 健康探针不打日志（巡检噪声）。
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return;
    const ms = Math.round(reply.elapsedTime ?? 0);
    log.info(`${req.method} ${req.url} -> ${reply.statusCode}`, { ms });
  });

  // 统一错误包络：校验失败 / 安全处理器抛错都转成 ApiResp。
  // 必须在注册 glue 路由之前设置——fastify 在路由注册时即把 error handler
  // 绑进路由上下文，之后再 setErrorHandler 对已注册路由不生效。
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error.statusCode ?? 500;
    const code =
      status === 401 ? 'UNAUTHENTICATED' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL';
    // 5xx 是真问题（带栈），4xx 是预期校验失败（仅一行）。
    if (status >= 500) log.error(`${req.method} ${req.url} ${status} ${code}`, { err: error.stack ?? error.message });
    else log.warn(`${req.method} ${req.url} ${status} ${code}`, { message: error.message });
    reply.code(status).send({ ok: false, error: { code, message: error.message } });
  });

  // 存活探针（不在 openapi.yml 内，glue 不接管）：反代 /api/health 剥前缀后命中 /health。
  // 供 compose / 负载均衡 / C-3 部署冒烟用。
  app.get('/health', async () => ({ ok: true }));

  const now = opts.now ?? (() => Date.now());
  const commercial =
    opts.commercial ?? new HttpCommercialClient(opts.commercialUrl ?? null, opts.internalKey);
  const gateway =
    opts.gateway ?? new HttpGatewayClient(opts.gatewayUrl ?? null, opts.internalKey);
  const service = new MetaService({
    cols: opts.cols,
    jwt: opts.jwt,
    now,
    commercial,
    gatewayPublicUrl: opts.gatewayPublicUrl ?? null,
    gateway,
    authRateLimit: opts.authRateLimit ?? 20,
    flags: opts.flags ?? null,
    region: opts.region ?? null,
    lokiPushUrl: opts.lokiPushUrl ?? null,
  });

  // 广告平台 SSV 回调（平台主动调用，不经 openapi glue，无玩家鉴权）。
  registerAdCallbackRoutes(app, { cols: opts.cols, commercial, now });

  // 内部路由（玩家不可见，X-Internal-Key 鉴权，不经 openapi glue）：取 ELO + 局末上报 + 对等裁判。
  registerInternalRoutes(app, {
    cols: opts.cols,
    internalKey: opts.internalKey,
    internalKeys: internalKeysFromEnv(),
    now,
    gateway,
    commercial,
  });

  await app.register(openapiGlue, {
    specification: SPEC_PATH,
    serviceHandlers: service,
    securityHandlers: makeSecurityHandlers(opts.jwt),
  });

  return app;
}
