// metaserver 进程引导：连 Mongo → buildApp → listen。
// 反代将 /api/* 转到本进程（SERVER_API.md §0）。
import { createMongo, createLogger, type JwtConfig } from '@nw/shared';
import { loadMetaEnv } from './config.js';
import { buildApp, SPEC_PATH } from './app.js';
import { HttpGatewayClient } from './gatewayClient.js';
import { auditOnce } from './anticheatAudit.js';

const log = createLogger('meta');

async function main() {
  const env = loadMetaEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const mongo = await createMongo(env.mongoUri, env.mongoDb);
  await mongo.ensureIndexes();

  const app = await buildApp({
    cols: mongo.collections,
    jwt,
    internalKey: env.internalKey,
    commercialUrl: env.commercialUrl,
    gatewayUrl: env.gatewayInternalUrl,
    gatewayPublicUrl: env.gatewayPublicUrl,
    // 请求日志走 buildApp 里可读的 onResponse 钩子（@nw/shared logger），不用 pino JSON。
    logger: false,
  });

  // 成就反作弊离线抽查批（S9-7，ACHIEVEMENT_DESIGN §4.4）：周期抽 ranked 局经 peer 裁判复算比对。
  // 留 index（同 buildApp 之外），不进请求路径；e2e 直接调 auditOnce。gateway 未配置 → available=false 整批跳过。
  const auditGateway = new HttpGatewayClient(env.gatewayInternalUrl, env.internalKey);
  const auditTimer =
    env.auditIntervalMs > 0
      ? setInterval(() => {
          void auditOnce({
            cols: mongo.collections,
            gateway: auditGateway,
            now: () => Date.now(),
            sampleLimit: env.auditSampleLimit,
          })
            .then((r) => {
              if (r.flagged > 0 || r.audited > 0) log.info('anti-cheat audit tick', { ...r });
            })
            .catch((e) => log.error('anti-cheat audit tick failed', { err: (e as Error).message }));
        }, env.auditIntervalMs)
      : null;
  auditTimer?.unref?.();

  const shutdown = async () => {
    if (auditTimer) clearInterval(auditTimer);
    await app.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
  log.info(`metaserver up on ${env.host}:${env.port}`, {
    spec: SPEC_PATH,
    commercial: env.commercialUrl ?? 'disabled',
    gateway: env.gatewayInternalUrl ?? 'disabled',
    gatewayPublic: env.gatewayPublicUrl ?? 'none',
  });
}

main().catch((e) => {
  log.error('metaserver failed to start', { err: (e as Error).stack ?? String(e) });
  process.exit(1);
});
