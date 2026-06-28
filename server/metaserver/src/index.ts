// metaserver 进程引导：连 Mongo → buildApp → listen。
// 反代将 /api/* 转到本进程（SERVER_API.md §0）。
import { createMongo, createLogger, startHeartbeat, FeatureFlagCache, internalHeaders, type JwtConfig } from '@nw/shared';
import { loadMetaEnv } from './config.js';
import { buildApp, SPEC_PATH } from './app.js';
import { HttpGatewayClient } from './gatewayClient.js';
import { auditOnce } from './anticheatAudit.js';

const log = createLogger('meta');

/**
 * 进程级错误告警（S4-3）。
 * NW_ALERT_WEBHOOK_URL：填 Slack/Discord/企微 webhook 地址时，uncaughtException/
 * unhandledRejection 额外 POST 一条告警消息（fire-and-forget，不影响主流程）。
 */
function setupAlerts(): void {
  const webhook = process.env.NW_ALERT_WEBHOOK_URL;
  const sendAlert = webhook
    ? (text: string) => {
        void fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[NW metaserver] ${text}` }),
        }).catch(() => {/* ignore webhook delivery failures */});
      }
    : null;

  process.on('uncaughtException', (e: Error) => {
    log.error('uncaughtException', { err: e.stack ?? String(e) });
    sendAlert?.(`uncaughtException: ${e.message}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    log.error('unhandledRejection', { reason: msg });
    sendAlert?.(`unhandledRejection: ${msg}`);
  });
}

setupAlerts();

async function main() {
  const env = loadMetaEnv();
  const jwt: JwtConfig = { secret: env.jwtSecret };

  const mongo = await createMongo(env.mongoUri, env.mongoDb);
  await mongo.ensureIndexes();

  // 功能开关缓存（公开 /bootstrap 求值用，FEATURE_FLAGS_DESIGN §9.3）：轮询 admin 原始规则 + 本地求值。
  // ⚠ 必须注入 NW_ADMIN_INTERNAL_URL（指向 http://admin:8083），否则不启动轮询 → 所有 flag 恒 default
  //   → bootstrap 恒回空 map → 客户端日志定向采集永不生效（同 matchsvc 的部署必坑）。
  const adminUrl = env.adminInternalUrl;
  const flags = new FeatureFlagCache({
    fetchAll: async () => {
      if (!adminUrl) return [];
      const res = await fetch(`${adminUrl}/admin/internal/flags`, {
        headers: internalHeaders('meta', env.internalKey),
      });
      if (!res.ok) throw new Error(`admin flags ${res.status}`);
      const body = (await res.json()) as { flags?: unknown[] };
      return Array.isArray(body.flags) ? body.flags : [];
    },
    ...(env.region ? { region: env.region } : {}),
    onError: (e) => log.warn('flag refresh failed (keeping cache)', { err: (e as Error).message }),
  });
  if (adminUrl) await flags.start();

  const app = await buildApp({
    cols: mongo.collections,
    jwt,
    internalKey: env.internalKey,
    commercialUrl: env.commercialUrl,
    gatewayUrl: env.gatewayInternalUrl,
    gatewayPublicUrl: env.gatewayPublicUrl,
    authRateLimit: env.authRateLimit,
    flags,
    region: env.region,
    lokiPushUrl: env.lokiPushUrl,
    socialsvcUrl: env.socialsvcInternalUrl,
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
  startHeartbeat(log); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main().catch((e) => {
  log.error('metaserver failed to start', { err: (e as Error).stack ?? String(e) });
  process.exit(1);
});
