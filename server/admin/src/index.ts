// admin 进程引导（OPS_DESIGN §0/§1）：运维后台后端，独立进程 + 独立库，玩家不可达。
//   • 连专属库 notebook_wars_admin → 索引 + 种子超管；
//   • AdminService（RBAC + 工单审批 + 审计 + 监控/趋势）；
//   • 对运维前端的 HTTP API（admin JWT 鉴权）；
//   • 自采采样定时器（拉 gateway/matchsvc /internal/stats 写 metricSnapshots）。
// 反代不路由到 admin；API 端口只在内网/VPN/IP allowlist 可达（§6）。
import { createLogger, loadInternalAuth, startHeartbeat, type JwtConfig } from '@nw/shared';
import { loadAdminEnv } from './config';
import { createAdminMongo } from './db';
import { AdminService } from './service';
import { startHttpApi } from './httpApi';
import { seedSuperAdmin } from './seed';
import { HttpAnalyticsClient, HttpAntiCheatClient, HttpEventsClient, HttpLadderClient, HttpMailDispatcher, HttpMismatchClient, HttpPlayerClient, HttpStatsClient, HttpSuspiciousPveClient, HttpWorldClient } from './clients';

const log = createLogger('admin');

async function main(): Promise<void> {
  const env = loadAdminEnv();

  const mongo = await createAdminMongo(env.adminMongoUri, env.adminMongoDb);
  await mongo.ensureIndexes(env.snapshotTtlSec);
  await seedSuperAdmin(mongo.collections, env.seedUser, env.seedPass, () => Date.now());

  const stats = new HttpStatsClient(env.gatewayInternalUrl, env.matchsvcInternalUrl, env.internalKey);
  const players = new HttpPlayerClient(env.metaBaseUrl, env.internalKey);
  const antiCheat = new HttpAntiCheatClient(env.metaBaseUrl, env.internalKey);
  const mismatches = new HttpMismatchClient(env.metaBaseUrl, env.internalKey);
  const suspiciousPve = new HttpSuspiciousPveClient(env.metaBaseUrl, env.internalKey);
  const mail = new HttpMailDispatcher(env.metaBaseUrl, env.internalKey);
  const analytics = new HttpAnalyticsClient(env.analyticsBaseUrl, env.internalKey);
  const world = new HttpWorldClient(env.worldInternalUrl, env.internalKey);
  const ladder = new HttpLadderClient(env.metaBaseUrl, env.internalKey);
  const events = new HttpEventsClient(env.metaBaseUrl, env.internalKey);

  const svc = new AdminService({ cols: mongo.collections, stats, players, antiCheat, mismatches, suspiciousPve, mail, analytics, world, ladder, events, now: () => Date.now() });

  const jwt: JwtConfig = { secret: env.adminJwtSecret, expiresIn: env.adminJwtTtl };
  const server = startHttpApi(
    { host: env.host, port: env.port, jwt, internalAuth: loadInternalAuth(env.internalKey) },
    svc,
  );

  // 自采采样定时器（§5）。stats 不可用时仍跑（写 0 值，趋势保持连续）。
  let sampler: NodeJS.Timeout | null = null;
  if (env.sampleIntervalMs > 0) {
    sampler = setInterval(() => {
      void svc.sampleOnce().catch((e) => log.error('sample failed', { err: (e as Error).message }));
    }, env.sampleIntervalMs);
    sampler.unref?.();
  }

  const shutdown = async (): Promise<void> => {
    if (sampler) clearInterval(sampler);
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('admin API listening', { port: env.port, db: env.adminMongoDb });
  console.log(`admin HTTP API on :${env.port} (ops front-end only); db=${env.adminMongoDb}`);
  console.log(
    `stats: gateway=${env.gatewayInternalUrl ?? 'none'} matchsvc=${env.matchsvcInternalUrl ?? 'none'}; ` +
      `meta(player/mail)=${env.metaBaseUrl ?? 'none'}; sample=${env.sampleIntervalMs}ms`,
  );
  startHeartbeat(log); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main().catch((e) => {
  console.error('admin failed to start:', e);
  process.exit(1);
});
