// socialsvc 环境变量（SOCIAL_SVC_DESIGN §7）。
// 第五公网面（/social/*），端口 8085，鉴权复用 meta JWT（仅 verifyToken）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface SocialsvcEnv extends ServerEnv {
  /** 公网 REST 端口（反代 /social/* → 此端口）。默认 8085。 */
  port: number;
  host: string;
  /** socialsvc 专属库 Mongo URI（默认复用主实例）。 */
  socialMongoUri: string;
  /** socialsvc 专属库名（nw_social，与主库物理隔离）。 */
  socialMongoDb: string;
  /** gateway 内部 HTTP 基址（socialsvc → /gw/push 推送实时事件）；缺省 = 不推送。 */
  gatewayInternalUrl: string | undefined;
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
  };
}
