// commercial 环境变量（S5-1，独立进程 + 独立库）。玩家不可达，只接 meta 的内部 HTTP。
// 复用 @nw/shared 的 internalKey（与 meta / gateway / matchsvc / game 共用一把）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface CommercialEnv extends ServerEnv {
  /** 内部 HTTP 端口（meta → 此端口；不暴露公网）。默认 18082（避开 Windows 保留段 8082）。 */
  port: number;
  host: string;
  /** commercial 专属库的 Mongo URI（默认复用 meta 同实例）。 */
  commMongoUri: string;
  /** commercial 专属库名（与 meta 库物理隔离）。 */
  commMongoDb: string;
}

export function loadCommercialEnv(): CommercialEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_COMM_PORT ?? 18082),
    host: process.env.NW_COMM_HOST ?? '0.0.0.0',
    commMongoUri: process.env.NW_COMM_MONGO_URI ?? base.mongoUri,
    commMongoDb: process.env.NW_COMM_MONGO_DB ?? 'notebook_wars_commercial',
  };
}
