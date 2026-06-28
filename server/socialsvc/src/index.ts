// socialsvc 进程引导（SOCIAL_SVC_DESIGN §7）。
// 第五公网面：/social/*，端口 8085。nw_social 独立库，鉴权复用 meta JWT。
import { createLogger, startHeartbeat } from '@nw/shared';
import { loadSocialsvcEnv } from './config';
import { createSocialMongo } from './db';
import { FamilyService } from './familyService';
import { HttpSocialGatewayClient, nullSocialGatewayClient } from './gatewayClient';
import { startHttpApi } from './httpApi';

async function main(): Promise<void> {
  const env = loadSocialsvcEnv();

  const mongo = await createSocialMongo(env.socialMongoUri, env.socialMongoDb);
  await mongo.ensureIndexes();

  const gateway = env.gatewayInternalUrl
    ? new HttpSocialGatewayClient(env.gatewayInternalUrl, env.internalKey)
    : nullSocialGatewayClient;

  const familySvc = new FamilyService({
    cols: mongo.collections,
    gateway,
    now: () => Date.now(),
  });

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    familySvc,
    gateway,
  );

  const shutdown = async (): Promise<void> => {
    server.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `socialsvc public REST on :${env.port}; db=${env.socialMongoDb}; ` +
      `gateway=${gateway.available ? 'on' : 'off'}`,
  );
  startHeartbeat(createLogger('socialsvc'));
}

main().catch((e) => {
  console.error('socialsvc failed to start:', e);
  process.exit(1);
});
