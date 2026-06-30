// socialsvc environment variables (SOCIAL_SVC_DESIGN §7).
// Fifth public face (/social/*), port 8085, auth reuses the meta JWT (verifyToken only).
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface SocialsvcEnv extends ServerEnv {
  /** Public REST port (reverse proxy /social/* → this port). Default: 8085. */
  port: number;
  host: string;
  /** socialsvc dedicated Mongo URI (defaults to the main instance). */
  socialMongoUri: string;
  /** socialsvc dedicated database name (nw_social, physically separate from the main database). */
  socialMongoDb: string;
  /** gateway internal HTTP base URL (socialsvc → /gw/push for real-time events); absent = no push. */
  gatewayInternalUrl: string | undefined;
  /** metaserver internal HTTP base URL (P2: publicId reverse-lookup + batch profiles); absent = account queries degrade gracefully. */
  metaInternalUrl: string | undefined;
}

export function loadSocialsvcEnv(): SocialsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_SOCIAL_PORT ?? 8085),
    host: process.env.NW_SOCIAL_HOST ?? '0.0.0.0',
    socialMongoUri: process.env.NW_SOCIAL_MONGO_URI ?? base.mongoUri,
    socialMongoDb: process.env.NW_SOCIAL_MONGO_DB ?? 'nw_social',
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL || undefined,
    metaInternalUrl: process.env.NW_META_INTERNAL_URL || undefined,
  };
}
