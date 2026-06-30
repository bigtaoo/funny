// commercial process bootstrap (S5-1): connect to dedicated DB → CommercialService → internal HTTP listen.
// Not reachable by players; the reverse proxy does not expose commercial — only meta can reach it via the internal network (X-Internal-Key).
import { createCommercialMongo } from './db';
import { CommercialService } from './service';
import { startInternalHttp } from './internalHttp';
import { loadCommercialEnv } from './config';
import { loadInternalAuth, IAP_TIERS, createLogger, startHeartbeat } from '@nw/shared';
import { createReceiptVerifier } from './iap';

async function main(): Promise<void> {
  // Hardening (L2-3): IAP dev stub must never be enabled in production — enabling it accidentally
  // allows `tier:`/`dev` receipts to bypass signature verification and grant coins directly.
  // Fail fast at startup rather than silently allowing it. The dev stub itself is also blocked for prod inside createReceiptVerifier.
  if (process.env.NODE_ENV === 'production' && process.env.NW_IAP_DEV === 'true') {
    console.error(
      'FATAL: NW_IAP_DEV=true is rejected in production (NODE_ENV=production) — ' +
        'the IAP dev stub allows forged receipts to bypass signature verification and grant coins. Remove NW_IAP_DEV or set it to false before restarting.',
    );
    process.exit(1);
  }

  const env = loadCommercialEnv();

  const mongo = await createCommercialMongo(env.commMongoUri, env.commMongoDb);
  await mongo.ensureIndexes();

  // verifyReceipt: real WeChat/Stripe receipt verification + dev stub fallback (S4-1).
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
  startHeartbeat(createLogger('commercial')); // Liveness heartbeat: one info log every 5 minutes when idle
}

main().catch((e) => {
  console.error('commercial failed to start:', e);
  process.exit(1);
});
