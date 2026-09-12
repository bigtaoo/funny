// socialsvc environment variables (SOCIAL_SVC_DESIGN §7).
// Fifth public face (/social/*), port 8085, auth reuses the meta JWT (verifyToken only).
import { DEV_MONGO_URI, loadServerEnv, requiredEnv, type ServerEnv } from '@nw/shared';

export interface SocialsvcEnv extends ServerEnv {
  /** Public REST port (reverse proxy /social/* → this port). Default: 8085. */
  port: number;
  host: string;
  /** Mongo URI for `nw_social` — this service's OWN least-privilege login.
   *  Never falls back to another service's variable; unset means the local dev Mongo (ADR-090). */
  socialMongoUri: string;
  /** socialsvc dedicated database name (nw_social, physically separate from the main database). */
  socialMongoDb: string;
  /** gateway internal HTTP base URL (socialsvc → /gw/push for real-time events); absent = no push. */
  gatewayInternalUrl: string | undefined;
  /** metaserver internal HTTP base URL (P2: publicId reverse-lookup + batch profiles); absent = account queries degrade gracefully. */
  metaInternalUrl: string | undefined;
  /** admin internal HTTP base URL (CONTENT_MODERATION_DESIGN.md §3.2: word list overlay polling); absent = built-in REGION_WORDLISTS only. */
  adminInternalUrl: string | undefined;
}

export function loadSocialsvcEnv(): SocialsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_SOCIAL_PORT ?? 8085),
    host: process.env.NW_SOCIAL_HOST ?? '0.0.0.0',
    socialMongoUri: requiredEnv('NW_SOCIAL_MONGO_URI', DEV_MONGO_URI),
    socialMongoDb: process.env.NW_SOCIAL_MONGO_DB ?? 'nw_social',
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL || undefined,
    metaInternalUrl: process.env.NW_META_INTERNAL_URL || undefined,
    adminInternalUrl: process.env.NW_ADMIN_INTERNAL_URL || undefined,
  };
}
