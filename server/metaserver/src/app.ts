// Fastify 应用装配（与进程引导分离，便于测试/inject）。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import openapiGlue from 'fastify-openapi-glue';
import type { Collections, JwtConfig } from '@nw/shared';
import { MetaService } from './service.js';
import { makeSecurityHandlers } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/app.js 与 src/app.ts 都在 metaserver 下两级 → contracts。
export const SPEC_PATH = resolve(here, '../../contracts/openapi.yml');

export interface BuildAppOpts {
  cols: Collections;
  jwt: JwtConfig;
  now?: () => number;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });

  // 统一错误包络：校验失败 / 安全处理器抛错都转成 ApiResp。
  // 必须在注册 glue 路由之前设置——fastify 在路由注册时即把 error handler
  // 绑进路由上下文，之后再 setErrorHandler 对已注册路由不生效。
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status = error.statusCode ?? 500;
    const code =
      status === 401 ? 'UNAUTHENTICATED' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL';
    reply.code(status).send({ ok: false, error: { code, message: error.message } });
  });

  // 存活探针（不在 openapi.yml 内，glue 不接管）：反代 /api/health 剥前缀后命中 /health。
  // 供 compose / 负载均衡 / C-3 部署冒烟用。
  app.get('/health', async () => ({ ok: true }));

  const service = new MetaService({
    cols: opts.cols,
    jwt: opts.jwt,
    now: opts.now ?? (() => Date.now()),
  });

  await app.register(openapiGlue, {
    specification: SPEC_PATH,
    serviceHandlers: service,
    securityHandlers: makeSecurityHandlers(opts.jwt),
  });

  return app;
}
