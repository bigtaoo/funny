// commercial 进程引导（S5-1）：连专属库 → CommercialService → 内部 HTTP listen。
// 玩家不可达；反代不暴露 commercial，只有 meta 经内部网络可达（X-Internal-Key）。
import { createCommercialMongo } from './db';
import { CommercialService } from './service';
import { startInternalHttp } from './internalHttp';
import { loadCommercialEnv } from './config';
import { loadInternalAuth, IAP_TIERS, createLogger, startHeartbeat } from '@nw/shared';
import { createReceiptVerifier } from './iap';

async function main(): Promise<void> {
  // 加固（L2-3）：生产环境严禁开启 IAP dev 桩——误开会让 `tier:`/`dev` 收据无验签直接发币。
  // 引导期拒启（fail fast），比静默放行安全。dev 桩本身在 createReceiptVerifier 内也对 prod 二次封死。
  if (process.env.NODE_ENV === 'production' && process.env.NW_IAP_DEV === 'true') {
    console.error(
      'FATAL: NW_IAP_DEV=true 在生产环境（NODE_ENV=production）下被拒绝启动——' +
        'IAP dev 桩会让伪造收据无验签发币。请移除 NW_IAP_DEV 或设为 false 后重启。',
    );
    process.exit(1);
  }

  const env = loadCommercialEnv();

  const mongo = await createCommercialMongo(env.commMongoUri, env.commMongoDb);
  await mongo.ensureIndexes();

  // verifyReceipt：微信/Stripe 真实验单 + dev 桩回退（S4-1）。
  const verifyReceipt = (platform: string, receipt: string) =>
    createReceiptVerifier(IAP_TIERS)(platform, receipt);

  const svc = new CommercialService({ cols: mongo.collections, now: () => Date.now(), verifyReceipt });
  const server = startInternalHttp(
    { host: env.host, port: env.port, internalAuth: loadInternalAuth(env.internalKey) },
    svc,
  );

  const shutdown = async (): Promise<void> => {
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `commercial internal HTTP on :${env.port} (meta-only); db=${env.commMongoDb}`,
  );
  startHeartbeat(createLogger('commercial')); // 存活心跳：空闲时每 5 分钟一条 info 日志
}

main().catch((e) => {
  console.error('commercial failed to start:', e);
  process.exit(1);
});
