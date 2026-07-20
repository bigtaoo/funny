// socialsvc process bootstrap (SOCIAL_SVC_DESIGN §7).
// Fifth public face: /social/*, port 8085. nw_social dedicated database; auth reuses the meta JWT.
// P1: family  P2: friends / private-chat / mail  P3: presence events
import { createLogger, startHeartbeat } from '@nw/shared';
import { loadSocialsvcEnv } from './config';
import { createSocialMongo } from './db';
import { FamilyService } from './familyService';
import { FriendService } from './friendService';
import { MailService } from './mailService';
import { HttpSocialGatewayClient, nullSocialGatewayClient } from './gatewayClient';
import { HttpSocialMetaClient, nullSocialMetaClient } from './metaClient';
import { startHttpApi } from './httpApi';

async function main(): Promise<void> {
  const env = loadSocialsvcEnv();

  const mongo = await createSocialMongo(env.socialMongoUri, env.socialMongoDb);
  await mongo.ensureIndexes();

  const gateway = env.gatewayInternalUrl
    ? new HttpSocialGatewayClient(env.gatewayInternalUrl, env.internalKey)
    : nullSocialGatewayClient;

  const meta = env.metaInternalUrl
    ? new HttpSocialMetaClient(env.metaInternalUrl, env.internalKey)
    : nullSocialMetaClient;

  const friendSvc = new FriendService({
    cols: mongo.collections,
    gateway,
    meta,
    now: () => Date.now(),
  });

  const mailSvc = new MailService({
    cols: mongo.collections,
    gateway,
    meta,
    now: () => Date.now(),
  });

  const familySvc = new FamilyService({
    cols: mongo.collections,
    gateway,
    meta,
    mail: mailSvc,
    now: () => Date.now(),
  });

  const server = startHttpApi(
    { host: env.host, port: env.port, jwtSecret: env.jwtSecret, internalKey: env.internalKey },
    familySvc,
    friendSvc,
    mailSvc,
    gateway,
    meta,
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
      `gateway=${gateway.available ? 'on' : 'off'}; meta=${meta.available ? 'on' : 'off'}`,
  );
  startHeartbeat(createLogger('socialsvc'));
}

main().catch((e) => {
  console.error('socialsvc failed to start:', e);
  process.exit(1);
});
