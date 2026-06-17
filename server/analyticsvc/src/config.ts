// analyticsvc 环境变量（A9-1）。
// 第九进程，玩家不可达（反代不路由，仅内网）。复用 meta JWT 仅 verifyToken 验签。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface AnalyticssvcEnv extends ServerEnv {
  port: number;
  host: string;
  /** 专属库 Mongo URI（默认复用 NW_MONGO_URI）。 */
  analyticsMongoUri: string;
  /** 专属库名（与 meta/commercial/admin/world 物理隔离）。 */
  analyticsMongoDb: string;
}

export function loadAnalyticssvcEnv(): AnalyticssvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_ANALYTICS_PORT ?? 18085),
    host: process.env.NW_ANALYTICS_HOST ?? '0.0.0.0',
    analyticsMongoUri: process.env.NW_ANALYTICS_MONGO_URI ?? base.mongoUri,
    analyticsMongoDb: process.env.NW_ANALYTICS_MONGO_DB ?? 'notebook_wars_analytics',
  };
}
