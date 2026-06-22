// commercial 进程引导（S5-1）：连专属库 → CommercialService → 内部 HTTP listen。
// 玩家不可达；反代不暴露 commercial，只有 meta 经内部网络可达（X-Internal-Key）。
import { createCommercialMongo } from './db';
import { CommercialService } from './service';
import { startInternalHttp } from './internalHttp';
import { loadCommercialEnv } from './config';
import { loadInternalAuth, IAP_TIERS } from '@nw/shared';
import { createReceiptVerifier } from './iap';

async function main(): Promise<void> {
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
}

main().catch((e) => {
  console.error('commercial failed to start:', e);
  process.exit(1);
});
